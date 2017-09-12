/**
 * SfxrParams
 *
 * Copyright 2010 Thomas Vian
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @author Thomas Vian
 */
/** @constructor */
function SfxrParams() {
  //--------------------------------------------------------------------------
  //
  //  Settings String Methods
  //
  //--------------------------------------------------------------------------

  /**
   * Parses a settings array into the parameters
   * @param array Array of the settings values, where elements 0 - 23 are
   *                a: waveType
   *                b: attackTime
   *                c: sustainTime
   *                d: sustainPunch
   *                e: decayTime
   *                f: startFrequency
   *                g: minFrequency
   *                h: slide
   *                i: deltaSlide
   *                j: vibratoDepth
   *                k: vibratoSpeed
   *                l: changeAmount
   *                m: changeSpeed
   *                n: squareDuty
   *                o: dutySweep
   *                p: repeatSpeed
   *                q: phaserOffset
   *                r: phaserSweep
   *                s: lpFilterCutoff
   *                t: lpFilterCutoffSweep
   *                u: lpFilterResonance
   *                v: hpFilterCutoff
   *                w: hpFilterCutoffSweep
   *                x: masterVolume
   * @return If the string successfully parsed
   */
  this.setSettings = function(values)
  {
    for ( var i = 0; i < 24; i++ )
    {
      this[String.fromCharCode( 97 + i )] = values[i] || 0;
    }

    // I moved this here from the reset(true) function
    if (this['c'] < .01) {
      this['c'] = .01;
    }

    var totalTime = this['b'] + this['c'] + this['e'];
    if (totalTime < .18) {
      var multiplier = .18 / totalTime;
      this['b']  *= multiplier;
      this['c'] *= multiplier;
      this['e']   *= multiplier;
    }
  }
}

/**
 * SfxrSynth
 *
 * Copyright 2010 Thomas Vian
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @author Thomas Vian
 */
/** @constructor */
function SfxrSynth() {
  // All variables are kept alive through function closures

  //--------------------------------------------------------------------------
  //
  //  Sound Parameters
  //
  //--------------------------------------------------------------------------

  this._params = new SfxrParams();  // Params instance

  //--------------------------------------------------------------------------
  //
  //  Synth Variables
  //
  //--------------------------------------------------------------------------

  var _envelopeLength0, // Length of the attack stage
      _envelopeLength1, // Length of the sustain stage
      _envelopeLength2, // Length of the decay stage

      _period,          // Period of the wave
      _maxPeriod,       // Maximum period before sound stops (from minFrequency)

      _slide,           // Note slide
      _deltaSlide,      // Change in slide

      _changeAmount,    // Amount to change the note by
      _changeTime,      // Counter for the note change
      _changeLimit,     // Once the time reaches this limit, the note changes

      _squareDuty,      // Offset of center switching point in the square wave
      _dutySweep;       // Amount to change the duty by

  //--------------------------------------------------------------------------
  //
  //  Synth Methods
  //
  //--------------------------------------------------------------------------

  /**
   * Resets the runing variables from the params
   * Used once at the start (total reset) and for the repeat effect (partial reset)
   */
  this.reset = function() {
    // Shorter reference
    var p = this._params;

    _period       = 100 / (p['f'] * p['f'] + .001);
    _maxPeriod    = 100 / (p['g']   * p['g']   + .001);

    _slide        = 1 - p['h'] * p['h'] * p['h'] * .01;
    _deltaSlide   = -p['i'] * p['i'] * p['i'] * .000001;

    if (!p['a']) {
      _squareDuty = .5 - p['n'] / 2;
      _dutySweep  = -p['o'] * .00005;
    }

    _changeAmount =  1 + p['l'] * p['l'] * (p['l'] > 0 ? -.9 : 10);
    _changeTime   = 0;
    _changeLimit  = p['m'] == 1 ? 0 : (1 - p['m']) * (1 - p['m']) * 20000 + 32;
  }

  // I split the reset() function into two functions for better readability
  this.totalReset = function() {
    this.reset();

    // Shorter reference
    var p = this._params;

    // Calculating the length is all that remained here, everything else moved somewhere
    _envelopeLength0 = p['b']  * p['b']  * 100000;
    _envelopeLength1 = p['c'] * p['c'] * 100000;
    _envelopeLength2 = p['e']   * p['e']   * 100000 + 12;
    // Full length of the volume envelop (and therefore sound)
    // Make sure the length can be divided by 3 so we will not need the padding "==" after base64 encode
    return ((_envelopeLength0 + _envelopeLength1 + _envelopeLength2) / 3 | 0) * 3;
  }

  /**
   * Writes the wave to the supplied buffer ByteArray
   * @param buffer A ByteArray to write the wave to
   * @return If the wave is finished
   */
  this.synthWave = function(buffer, length) {
    // Shorter reference
    var p = this._params;

    // If the filters are active
    var _filters = p['s'] != 1 || p['v'],
        // Cutoff multiplier which adjusts the amount the wave position can move
        _hpFilterCutoff = p['v'] * p['v'] * .1,
        // Speed of the high-pass cutoff multiplier
        _hpFilterDeltaCutoff = 1 + p['w'] * .0003,
        // Cutoff multiplier which adjusts the amount the wave position can move
        _lpFilterCutoff = p['s'] * p['s'] * p['s'] * .1,
        // Speed of the low-pass cutoff multiplier
        _lpFilterDeltaCutoff = 1 + p['t'] * .0001,
        // If the low pass filter is active
        _lpFilterOn = p['s'] != 1,
        // masterVolume * masterVolume (for quick calculations)
        _masterVolume = p['x'] * p['x'],
        // Minimum frequency before stopping
        _minFreqency = p['g'],
        // If the phaser is active
        _phaser = p['q'] || p['r'],
        // Change in phase offset
        _phaserDeltaOffset = p['r'] * p['r'] * p['r'] * .2,
        // Phase offset for phaser effect
        _phaserOffset = p['q'] * p['q'] * (p['q'] < 0 ? -1020 : 1020),
        // Once the time reaches this limit, some of the    iables are reset
        _repeatLimit = p['p'] ? ((1 - p['p']) * (1 - p['p']) * 20000 | 0) + 32 : 0,
        // The punch factor (louder at begining of sustain)
        _sustainPunch = p['d'],
        // Amount to change the period of the wave by at the peak of the vibrato wave
        _vibratoAmplitude = p['j'] / 2,
        // Speed at which the vibrato phase moves
        _vibratoSpeed = p['k'] * p['k'] * .01,
        // The type of wave to generate
        _waveType = p['a'];

    var _envelopeLength      = _envelopeLength0,     // Length of the current envelope stage
        _envelopeOverLength0 = 1 / _envelopeLength0, // (for quick calculations)
        _envelopeOverLength1 = 1 / _envelopeLength1, // (for quick calculations)
        _envelopeOverLength2 = 1 / _envelopeLength2; // (for quick calculations)

    // Damping muliplier which restricts how fast the wave position can move
    var _lpFilterDamping = 5 / (1 + p['u'] * p['u'] * 20) * (.01 + _lpFilterCutoff);
    if (_lpFilterDamping > .8) {
      _lpFilterDamping = .8;
    }
    _lpFilterDamping = 1 - _lpFilterDamping;

    var _finished = false,     // If the sound has finished
        _envelopeStage    = 0, // Current stage of the envelope (attack, sustain, decay, end)
        _envelopeTime     = 0, // Current time through current enelope stage
        _envelopeVolume   = 0, // Current volume of the envelope
        _hpFilterPos      = 0, // Adjusted wave position after high-pass filter
        _lpFilterDeltaPos = 0, // Change in low-pass wave position, as allowed by the cutoff and damping
        _lpFilterOldPos,       // Previous low-pass wave position
        _lpFilterPos      = 0, // Adjusted wave position after low-pass filter
        _periodTemp,           // Period modified by vibrato
        _phase            = 0, // Phase through the wave
        _phaserInt,            // Integer phaser offset, for bit maths
        _phaserPos        = 0, // Position through the phaser buffer
        _pos,                  // Phase expresed as a Number from 0-1, used for fast sin approx
        _repeatTime       = 0, // Counter for the repeats
        _sample,               // Sub-sample calculated 8 times per actual sample, averaged out to get the super sample
        _superSample,          // Actual sample writen to the wave
        _vibratoPhase     = 0; // Phase through the vibrato sine wave

    // Buffer of wave values used to create the out of phase second wave
    var _phaserBuffer = new Array(1024),
        // Buffer of random values used to generate noise
        _noiseBuffer  = new Array(32);
    for (var i = _phaserBuffer.length; i--; ) {
      _phaserBuffer[i] = 0;
    }
    for (var i = _noiseBuffer.length; i--; ) {
      _noiseBuffer[i] = Math.random() * 2 - 1;
    }

    for (var i = 0; i < length; i++) {
      if (_finished) {
        return i;
      }

      // Repeats every _repeatLimit times, partially resetting the sound parameters
      if (_repeatLimit) {
        if (++_repeatTime >= _repeatLimit) {
          _repeatTime = 0;
          this.reset();
        }
      }

      // If _changeLimit is reached, shifts the pitch
      if (_changeLimit) {
        if (++_changeTime >= _changeLimit) {
          _changeLimit = 0;
          _period *= _changeAmount;
        }
      }

      // Acccelerate and apply slide
      _slide += _deltaSlide;
      _period *= _slide;

      // Checks for frequency getting too low, and stops the sound if a minFrequency was set
      if (_period > _maxPeriod) {
        _period = _maxPeriod;
        if (_minFreqency > 0) {
          _finished = true;
        }
      }

      _periodTemp = _period;

      // Applies the vibrato effect
      if (_vibratoAmplitude > 0) {
        _vibratoPhase += _vibratoSpeed;
        _periodTemp *= 1 + Math.sin(_vibratoPhase) * _vibratoAmplitude;
      }

      _periodTemp |= 0;
      if (_periodTemp < 8) {
        _periodTemp = 8;
      }

      // Sweeps the square duty
      if (!_waveType) {
        _squareDuty += _dutySweep;
        if (_squareDuty < 0) {
          _squareDuty = 0;
        } else if (_squareDuty > .5) {
          _squareDuty = .5;
        }
      }

      // Moves through the different stages of the volume envelope
      if (++_envelopeTime > _envelopeLength) {
        _envelopeTime = 0;

        switch (++_envelopeStage)  {
          case 1:
            _envelopeLength = _envelopeLength1;
            break;
          case 2:
            _envelopeLength = _envelopeLength2;
        }
      }

      // Sets the volume based on the position in the envelope
      switch (_envelopeStage) {
        case 0:
          _envelopeVolume = _envelopeTime * _envelopeOverLength0;
          break;
        case 1:
          _envelopeVolume = 1 + (1 - _envelopeTime * _envelopeOverLength1) * 2 * _sustainPunch;
          break;
        case 2:
          _envelopeVolume = 1 - _envelopeTime * _envelopeOverLength2;
          break;
        case 3:
          _envelopeVolume = 0;
          _finished = true;
      }

      // Moves the phaser offset
      if (_phaser) {
        _phaserOffset += _phaserDeltaOffset;
        _phaserInt = _phaserOffset | 0;
        if (_phaserInt < 0) {
          _phaserInt = -_phaserInt;
        } else if (_phaserInt > 1023) {
          _phaserInt = 1023;
        }
      }

      // Moves the high-pass filter cutoff
      if (_filters && _hpFilterDeltaCutoff) {
        _hpFilterCutoff *= _hpFilterDeltaCutoff;
        if (_hpFilterCutoff < .00001) {
          _hpFilterCutoff = .00001;
        } else if (_hpFilterCutoff > .1) {
          _hpFilterCutoff = .1;
        }
      }

      _superSample = 0;
      for (var j = 8; j--; ) {
        // Cycles through the period
        _phase++;
        if (_phase >= _periodTemp) {
          _phase %= _periodTemp;

          // Generates new random noise for this period
          if (_waveType == 3) {
            for (var n = _noiseBuffer.length; n--; ) {
              _noiseBuffer[n] = Math.random() * 2 - 1;
            }
          }
        }

        // Gets the sample from the oscillator
        switch (_waveType) {
          case 0: // Square wave
            _sample = ((_phase / _periodTemp) < _squareDuty) ? .5 : -.5;
            break;
          case 1: // Saw wave
            _sample = 1 - _phase / _periodTemp * 2;
            break;
          case 2: // Sine wave (fast and accurate approx)
            _pos = _phase / _periodTemp;
            _pos = (_pos > .5 ? _pos - 1 : _pos) * 6.28318531;
            _sample = 1.27323954 * _pos + .405284735 * _pos * _pos * (_pos < 0 ? 1 : -1);
            _sample = .225 * ((_sample < 0 ? -1 : 1) * _sample * _sample  - _sample) + _sample;
            break;
          case 3: // Noise
            _sample = _noiseBuffer[Math.abs(_phase * 32 / _periodTemp | 0)];
        }

        // Applies the low and high pass filters
        if (_filters) {
          _lpFilterOldPos = _lpFilterPos;
          _lpFilterCutoff *= _lpFilterDeltaCutoff;
          if (_lpFilterCutoff < 0) {
            _lpFilterCutoff = 0;
          } else if (_lpFilterCutoff > .1) {
            _lpFilterCutoff = .1;
          }

          if (_lpFilterOn) {
            _lpFilterDeltaPos += (_sample - _lpFilterPos) * _lpFilterCutoff;
            _lpFilterDeltaPos *= _lpFilterDamping;
          } else {
            _lpFilterPos = _sample;
            _lpFilterDeltaPos = 0;
          }

          _lpFilterPos += _lpFilterDeltaPos;

          _hpFilterPos += _lpFilterPos - _lpFilterOldPos;
          _hpFilterPos *= 1 - _hpFilterCutoff;
          _sample = _hpFilterPos;
        }

        // Applies the phaser effect
        if (_phaser) {
          _phaserBuffer[_phaserPos % 1024] = _sample;
          _sample += _phaserBuffer[(_phaserPos - _phaserInt + 1024) % 1024];
          _phaserPos++;
        }

        _superSample += _sample;
      }

      // Averages out the super samples and applies volumes
      _superSample *= .125 * _envelopeVolume * _masterVolume;

      // Clipping if too loud
      buffer[i] = _superSample >= 1 ? 32767 : _superSample <= -1 ? -32768 : _superSample * 32767 | 0;
    }

    return length;
  }
}

// Adapted from http://codebase.es/riffwave/
var synth = new SfxrSynth();
// Export for the Closure Compiler
window['jsfxr'] = function(settings) {
  // Initialize SfxrParams
  synth._params.setSettings(settings);
  // Synthesize Wave
  var envelopeFullLength = synth.totalReset();
  var data = new Uint8Array(((envelopeFullLength + 1) / 2 | 0) * 4 + 44);
  var used = synth.synthWave(new Uint16Array(data.buffer, 44), envelopeFullLength) * 2;
  var dv = new Uint32Array(data.buffer, 0, 44);
  // Initialize header
  dv[0] = 0x46464952; // "RIFF"
  dv[1] = used + 36;  // put total size here
  dv[2] = 0x45564157; // "WAVE"
  dv[3] = 0x20746D66; // "fmt "
  dv[4] = 0x00000010; // size of the following
  dv[5] = 0x00010001; // Mono: 1 channel, PCM format
  dv[6] = 0x0000AC44; // 44,100 samples per second
  dv[7] = 0x00015888; // byte rate: two bytes per sample
  dv[8] = 0x00100002; // 16 bits per sample, aligned on every two bytes
  dv[9] = 0x61746164; // "data"
  dv[10] = used;      // put number of samples here

  // Base64 encoding written by me, @maettig
  used += 44;
  var i = 0,
      base64Characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
      output = 'data:audio/wav;base64,';
  for (; i < used; i += 3)
  {
    var a = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
    output += base64Characters[a >> 18] + base64Characters[a >> 12 & 63] + base64Characters[a >> 6 & 63] + base64Characters[a & 63];
  }
  return output;
}

// -------------------------------------------------------------------------------

function randomRange(min, max) {
    return Math.floor(Math.random() * (max-min)) + min;
}

function pause(f, d) {
    setTimeout(f.bind(this), d);
}

function rd(value) {
    return Math.round(value);
}

function css(el, props) {
    for (var p in props) {
        el.style[p] = props[p];
    }
}

function create(type, id) {
    var el = document.createElement(type);
    if (id) el.setAttribute("id", id);
    return el;
}

function remove(el) {
    el.parentNode.removeChild(el);
}

function $(id) {
    return document.getElementById(id);
}

var DHTMLSprite = function (params) {
     var w = params.w,
         h = params.h,
         iW = params.iW,
         el = params.t.appendChild(create("div")),
         st = el.style,
         mF = Math.floor,
         anims = [],
         canim = [],
         dx = 0,
         dy = 0,
         ii = 0,
         ci = 0;
     css(el, {
         position: 'absolute', 
         left: "-9999px", /*********************/
         width: w+"px",
         height: h+"px",
         backgroundImage: 'url(' + params.img + ')'
     });
     var that = {
        diff: function(x, y) {
            dx = x;
            dy = y;
        },
        aA: function(animsArr) {
            anims = animsArr;
        },
        dw: function (x, y) {
            st.left = x + 'px';
            st.top = y + 'px';
        },
        bI: function(index) {
            ci = index;
            that.cI(ci);
        },
        cI: function (index) {
            index *= w;
            var vOffset = -mF(index / iW) * h;
            var hOffset = -index % iW;
            st.backgroundPosition = hOffset + 'px ' + vOffset + 'px';
        },
        cA: function(anim) {
            if (anims[anim]) {
                canim = anims[anim];
            }
        },
        i: function() {
            return ci;
        },
        sh: function () {
            st.display = 'block';
        },
        hi: function () {
            st.display = 'none';
        },
        k: function () {
            remove(el);
        },
        mv: function(dt, dir) {
            if (!dt) return;
            that.cI(ci + canim[mF(ii)]);
            ii += dt/1000 * anims.v;
            if (ii >= canim.length) {
                ii = 0;
            }
        },
        v: function() {
            return anims.v;
        },
        dxy: function() {
            return [dx/500, dy/500];
        }
     };
     return that;
};

const EPEM     = 0,
      EEEM      = 1,
      STS        = 2,
      SP             = 3,
      SS             = 4,
      SI      = 5,
      EPD         = 6,
      SG            = 7,
      EWD        = 8,
      SIM          = 9,
      IL                = 1;

const storyline = [
    "Scavenge for survival",
    "Oops. I am not alone",
    "Obstacles are the key",
    "Some of them are short sighted",
    "I can destroy obstacles too",
    "Brown jackets are trouble",
    "Each move counts",
    "Harder than I thought",
    "I hate Zetas",
    "It's a long way to the top",
    "What's the story, morning glory?",
    "You still there, man?",
    "Is there no end for this?",
    "I don't think I can make it",
    "There is a light that never goes out",
    "I know: big mouth strikes again"
];

const categories = [
    "Burguer meat",
    "Zombie fodder",
    "Novice",
    "Inexperienced",
    "Second rate",
    "Mediocre",
    "Handy",
    "Skilled",
    "Old timer",
    "Veteran",
    "Seasoned pro",
    "Superb",
    "Outstanding",
    "Master"
];

var SYS_spriteParams = {
        w: 32,
        h: 32,
        iW: 256,
        img: "s3.png",
        t: $("screen")
    },
    columns = 8, rows = 8, level = 2, screen, score, title, oldTime,
    floorTiles = [31], wallTiles = [25, 26, 27, 28, 29, 30],
    outerWallTiles = [21, 22, 23, 24], foodTiles = [18, 19],
    enemyTiles = [6, 12], enemyHit = [20, 30], enemyAI = [3, 4],
    board = [], objects = [], enemies = [], gridPositions = [], player, detection, enemiesToMove = [],
    initialEnergy = 25, currentEnergy, maxEnergy,
    isPlayerMoving = false, isPlayerTurn = true, isPlayerDetectedBy = null,
    isEnemyMoving = false, animating = false, gameIsOver = false,
    gameState = SIM,
    FRUIT_ENERGY = 12, SODA_ENERGY = 20,
    soundLib = [],
    raf = window.requestAnimationFrame;

var sounds = [
    [2,0.0266,0.5034,0.5728,0.5999,0.5026,,-0.0108,-0.4073,,,,,0.543,0.7178,0.7558,,0.9082,0.9809,0.1312,-0.4545,0.0055,0.0025,0.4], // 0 - detection
    [3,0.14,0.31,0.0939,0.47,0.03,0.0071,-0.1999,0.34,0.24,0.0685,-0.28,,0.0233,-0.0799,,0.0104,0.4403,0.27,0.02,0.21,0.12,-0.18,0.32], // 1 - zombie attack
    [3,,0.35,0.53,0.2582,0.1909,,0.2963,,,,,,,,,0.3,-0.0396,1,,,,,0.18], // 2 - wall attack
    [0,,0.0878,,0.4572,0.2507,,0.2093,,0.1437,0.3611,,,0.5666,,,,,1,,,,,0.3], // 3 - food
    [0,0.34,0.26,0.24,0.23,,,0.1232,0.1466,0.24,1,0.9299,,,-1,1,-0.8,-0.04,0.33,-0.02,,,-1,0.36], // 4 - walk
    [3,0.0171,0.9078,0.3427,0.4125,0.5181,0.0587,-0.1099,0.484,0.0317,0.4421,-0.4199,0.5661,0.049,0.0066,0.2124,-0.8404,-0.1955,0.3985,-0.0415,,0.0212,-0.0439,0.32] // 5 - exit level
];

function initSound() {
    sounds.forEach(function(s, i) {
        var fx = jsfxr(s);
        var a = new Audio();
        a.src = fx;
        soundLib.push(a);
    });
}

function init() {
    // Clears our list gridPositions and prepares it to generate a new board.
    gridPositions = [];
    for (var x = 1; x < columns-1; x++) {
        for (var y = 1; y < rows -1; y++) {
            if (((x == 1 || x == 2) && y == 6) || ((x == 1 || x == 2) && y == 7) || ((x == 0 || x == 1 || x == 2) && y == 5)) continue;
            gridPositions.push([x, y]);
        }
    }
    board = [];
    enemies = [];
    object = [];
    var childs = $("screen").children;
    for (x=0, l=childs.length;x<l; x++) {
        if (childs[x] && childs[x].parentNode) {
            childs[x].parentNode.removeChild(childs[x]);
        }
    }
    
    // Generate random background tiles
    for (var x=-1; x<columns+1; x++) {
        for (var y=-1; y<rows+1; y++) {
            var tile = DHTMLSprite(SYS_spriteParams);
            tile.bI(floorTiles[randomRange(0, floorTiles.length)]);

            if (x === -1 || x === columns || y === -1 || y === rows) {
                tile.bI(outerWallTiles[randomRange(0, outerWallTiles.length)]);
            }

            board.push([tile, x, y, "t"]); // sprite, posX, posY, type: t for tile, e for entity, f for food... 
        }
    }

    // the exit
    var exitSprite = DHTMLSprite(SYS_spriteParams);
    exitSprite.bI(20);
    board.push([exitSprite, columns-1, 0]);

    // wall tiles
    objects = layoutObjectsAtRandom(wallTiles, 5, 10, "w");

    // food tiles
    objects = objects.concat(layoutObjectsAtRandom(foodTiles, 1, 5, "f"));

    // enemies
    var enemyCount = Math.log2(level) | 0;
    var enemyAnims = {
        i:  [0, 1, 2, 3, 4, 5],
        a:  [28, 29], // 24, 25
        v:  4
    };
    enemies = layoutObjectsAtRandom(enemyTiles, enemyCount, enemyCount, "e", enemyAnims);

    var playerSprite = DHTMLSprite(SYS_spriteParams);
    playerSprite.cI(0);
    playerSprite.aA({
        i: [0, 1, 2, 3, 4, 5],
        a: [32, 33],
        d: [38, 39],
        v: 6
    });
    playerSprite.cA("i");
    player = [playerSprite, 0, rows-1, "p"];

    // score
    screen = $("screen");
    score = create("div", "score");
    score.innerHTML = "<p>energy: " + currentEnergy + "</p>";
    screen.appendChild(score);
    score.update = function() {
        score.innerHTML = "<p>energy: " + currentEnergy + "</p>";
    };
}

// --------------------------------------------------------------------------------------

function drawItem(t) {
    t[0].dw((t[1]+1)*SYS_spriteParams.w, (t[2]+1)*SYS_spriteParams.h);
}

function launchDetectIcon() {
    var spr = DHTMLSprite(SYS_spriteParams);
    spr.bI(46);
    spr.aA({i: [1, 0], v: 8});
    spr.cA("i");
    detection = [spr, player[1]+.5, player[2]-.5, "!"];
    pause(function() {
        detection[0].k();
        detection = null;
    }, 1000);
    soundLib[0].play();
}

// LayoutObjectAtRandom accepts an array of game objects to choose from 
// along with a minimum and maximum range for the number of objects to create.
function layoutObjectsAtRandom(tiles, min, max, type, anims) {
    var objectCount = randomRange(min, max+1);
    var destArray = [];
    for (var i=0; i<objectCount; i++) {
        (function() {
            var rndPos = randomPosition();
            var sprite = DHTMLSprite(SYS_spriteParams);
            var choice = randomRange(0, tiles.length);
            var tileChoice = tiles[choice];
            sprite.bI(tileChoice);

            if (type !== "e") {
                var t = [sprite, rndPos[0], rndPos[1], type]; // sprite, x, y, type, energy
                t[4] = 2; // in case is a wall
                if (type === "f") { // FOOD
                    if (tileChoice === 19) {
                        t[4] = FRUIT_ENERGY;
                    } else {
                        t[4] = SODA_ENERGY;
                    }
                }
                destArray.push(t);
            } else { // ENEMIES
                var ans = Object.assign({}, anims);
                if (tileChoice == 12) ans.a = [24, 25]; // patch for new spritesheet
                sprite.aA(ans);
                sprite.cA("i");
                var e = [sprite, rndPos[0], rndPos[1], type]; // sprite, x, y, type, hitPoints, viewRange
                if (tileChoice == 6 || tileChoice == 12) {
                    e[4] = enemyHit[choice];
                    e[5]= enemyAI[choice];
                }
                e[3] = type;
                destArray.push(e);
            }
        })();
    }
    return destArray;
};

function attemptMove(char, dir) {
    var destX = char[1];
    if (dir == "r") {
        destX++;
    }
    if (dir == "l") {
        destX--;
    }
    var destY = char[2];
    if (dir == "u") {
        destY--;
    }
    if (dir == "d") {
        destY++;
    }

    for (var i=0; i<enemies.length; i++) {
        if (enemies[i][1] == destX && enemies[i][2] == destY && enemies[i][3] !== "f") {
            return "n";
        }
    }
    for (var i=0; i<objects.length; i++) {
        if (objects[i][1] == destX && objects[i][2] == destY) {
            return objects[i];
        }
    }
    if (player[1] == destX && player[2] == destY) return player;
    return "y";
};

function damage(entity) {
    entity[4] --;
    if (entity[4] == 1) entity[0].cI(entity[0].i() + 15);
    if (entity[4] <= 0) {
        entity[3] = "r";
        entity[0].k();
        gameCallback(EWD);
    }
}

function doAnimate(char, dir) {
    animating = true;

    var moveAttempt = attemptMove(char, dir);
    if (moveAttempt === "n") {
        endCharacterMove(char);
        return;
    } else if (moveAttempt[3] === "w" || moveAttempt[3] === "p") {
        if (moveAttempt[3] === "p") {
            moveAttempt[0].cA("d");
            gameCallback(EPD, char[4]);
            var forcePlayerIdle = true;
            soundLib[1].play();
        }
        if (moveAttempt[3] === "w") {
            var r = randomRange(1, 4);
            if (isPlayerDetectedBy != char && r < 2) {
                endCharacterMove(char);
                return;
            }
            damage(moveAttempt);
            soundLib[2].play();
        }
        char[0].cA("a");
        pause(function() {
            char[0].cA("i");
            if (forcePlayerIdle) moveAttempt[0].cA("i");
            endCharacterMove(char);
        }, 500);
        return;
    }

    var x = char[1], y = char[2];
    switch (dir) {
        case "l":
            if (char[1] > 0) {
                x--;
                char[0].diff(-1, 0);
                playWalkSound();
            }
            break;
        case "r":
            if (char[1] < columns-1) {
                x++;
                char[0].diff(1, 0);
                playWalkSound();
            }
            break;
        case "u":
            if (char[2] > 0) {
                y--;
                char[0].diff(0, -1);
                playWalkSound();
            }
            break;
        case "d":
            if (char[2] < rows-1) {
                y++;
                char[0].diff(0, 1);
                playWalkSound();
            }
            break;
    }
    endCharacterMove(char, x, y);
}

function playWalkSound() {
    soundLib[4].play();
}

// RandomPosition returns a random position from our list gridPositions.
function randomPosition() {
    var randomIndex = randomRange(0, gridPositions.length);
    var randomPosition = gridPositions.splice(randomIndex, 1)[0];

    return randomPosition;
};

function decideMovement(enemy) {
    // enemy [sprite, x, y, type, hitPoints, viewRange]
    var options = ["l", "r", "u", "d"];
    var distanceToPlayer = Math.abs(enemy[1] - player[1]) + Math.abs(enemy[2] - player[2]);
    var decision = ""; 

    if (distanceToPlayer <= enemy[5]) {
        if (!detection && !isPlayerDetectedBy) {
            isPlayerDetectedBy = enemy;
            launchDetectIcon();
        }
        if (enemy[2] > player[2]) {
            decision = "u";
        } else if (enemy[2] < player[2]) {
            decision = "d";
        } 
        if (decision === "") {
            if (enemy[1] > player[1]) {
                decision = "l";
            } else if (enemy[1] < player[1]) {
                decision = "r";
            }
        }
    } else { // random decision
        decision = options[randomRange(0, options.length)];
        if (isPlayerDetectedBy == enemy) isPlayerDetectedBy = null;
    }
    doAnimate(enemy, decision);
}

function checkCurrentTile() {
    objects.forEach(function(obj, i) {
        // sprite, x, y, "f" (type), energy
        if (obj[1] === player[1] && obj[2] === player[2]) {
            currentEnergy += obj[4];
            soundLib[3].play();
            objects.splice(i, 1);
            obj[0].k();
            return false;
        }
    });
    if (player[1] === columns-1 && player[2] === 0) {
        return true;
    }
}

function checkMaxEnergy() {
    if (maxEnergy < currentEnergy) maxEnergy = currentEnergy;
}

function checkGameOver() {
    if (currentEnergy <= 0) {
        gameIsOver = true;
        gameState = SG;
    }
}

function gameLoop() {
    var newTime = +new Date();
    var elapsed = newTime - oldTime;
    oldTime = newTime;
    
    switch (gameState) {
        case SIM:
            title.innerHTML = "<p>ROGUE SCAVENGER 13K</p>";
            screen.style.display = "none";
            title.style.display = "block";
            raf(gameLoop);
            return;
            break;
            
        case SI: 
            gameIsOver = false;
            isPlayerDetectedBy = null;
            currentEnergy = maxEnergy = initialEnergy;
            level = IL;
            init();
            gameState = STS;
            break;

        case SP:
            if (isPlayerTurn && !isPlayerMoving) {
                checkMaxEnergy();
                checkGameOver();
                handleKeys();
            } else if (!isPlayerTurn && !isEnemyMoving) {
                var enemy = enemiesToMove.pop();
                if (enemy) {
                    pause(function() {
                        decideMovement(enemy);
                    }, 250);
                    isEnemyMoving = true;
                } else {
                    isPlayerTurn = true;
                }
            }

            break;

        case STS:
            /*
            https://developer.mozilla.org/en-US/docs/Web/API/Window/speechSynthesis
            https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis
            
            https://twitter.com/intent/tweet?url=http%3A%2F%2Fmydomain%2F%3Fparam1%3Dsomething%26param2%3Dsomtehing%26param3%3Dsomething&text=hola%20caracola
            */
            var synth = window.speechSynthesis;
            pause(function() {
                var voices = synth.getVoices();
                var selected = 0;
                voices.forEach(function(v, i) {
                    if (v.lang.indexOf("en") >= 0 && v.name == "Google UK English Male") {
                        selected = i;
                    }
                });
                var utter = new SpeechSynthesisUtterance("Day " + level + ". " + (storyline[level-1] || ""));
                utter.voice = voices[selected];  // 9 es graciosa
                utter.pitch = 0.5;
                utter.rate = 0.8;
                synth.speak(utter);
            }, 500);
            
            title.innerHTML = "<p>DAY " + level + ".</p><p class='small'>"+(storyline[level-1] || "")+"</p>";
            screen.style.display = "none";
            title.style.display = "block";
            gameState = SS;
            pause(function() {
                init();
                screen.style.display = "block";
                title.style.display = "none";
                gameState = SP;
            }, 2500);
            break;

        case SS:
            break;

        case SG:
            var outcome = (level >= l) ?  categories[l-1] : categories[level] || categories[0];
            var twTxt = "I died of starvation after " + level + " days of zombie apocalypse. I am a " + outcome + " scavenger.";
            title.innerHTML = "<p>You DIED</p><p class='small'>of starvation after " + level + " days.<br/>You managed to have " + maxEnergy + " food.<br/>"+outcome+" scavenger.<br/><a href='https://twitter.com/intent/tweet?url=http://www.js13kgames.com/rogue-scavenger13k&text=" + twTxt + "' target='_blank'>TWEET IT!</a></p>";
            screen.style.display = "none";
            title.style.display = "block";
            gameState = SS;
    }
    
    updateLoop(elapsed);
    drawLoop();
    
    raf(gameLoop);
}

function gameCallback(msg) {
    //if (gameOverFlag) return;

    switch (msg) {
        case EPEM:
            currentEnergy--;

            var isExit = checkCurrentTile();

            if (isExit) {
                isPlayerTurn = true;
                isPlayerMoving = false;
                isPlayerDetectedBy = null;
                soundLib[5].play();
                pause(function() {
                    level++;
                    gameState = STS;
                }, 1000);
            } else {
                pause(function() {
                    isPlayerTurn = false;
                    isPlayerMoving = false;
                    enemiesToMove = enemies.slice(0);
                }, 250);
            }
            score.update();
            break;

        case EEEM:
            isEnemyMoving = false;
            break;

        case EPD: 
            currentEnergy -= arguments[1];
            score.update();
            break;

        case EWD:
            for (var q=0; q<objects.length; q++) {
                var w = objects[q];
                if (w[3] === "r") { // change any value for "r" and remove
                    objects.splice(q, 1);
                    break;
                }
            }
            break;
    }
}

function updateLoop(dt) {
    player[0].mv(dt);
    if (animating) {
        var diff = player[0].dxy();
        player[1] += diff[0] * dt;
        player[2] += diff[1] * dt;
    }
    
    enemies.forEach(function(e) {
        e[0].mv(dt);
        if (animating) {
            var diff = e[0].dxy();
            e[1] += diff[0] * dt;
            e[2] += diff[1] * dt;
        }
    });
    
    if (detection) detection[0].mv(dt);
}

function handleKeys() {
    isPlayerMoving = true;
    if (keys[0]) { // left
        doAnimate(player, "l");
    } else if (keys[2]) {  // right
        doAnimate(player, "r");
    } else if (keys[1]) {  // up
        doAnimate(player, "u");
    } else if (keys[3]) {
        doAnimate(player, "d");
    } else {
        isPlayerMoving = false;
    }
}

function endCharacterMove(char, x, y) {
    pause(function() {
        animating = false;
        char[0].diff(0, 0);
        if(x) char[1] = x;
        if(y) char[2] = y;
        char[1] = rd(char[1]);
        char[2] = rd(char[2]);
        if (char[3] == "p") {
            gameCallback(EPEM);
        } else {
            gameCallback(EEEM);
        }
    }, 500);
}

function drawLoop() {
    board.forEach(drawItem); // draw Board
    objects.forEach(drawItem); // draw walls and food
    enemies.forEach(drawItem); // draw enemies
    drawItem(player); // draw player
    if (detection) drawItem(detection); // draw detection icon
}

function switchMusic() {
    gainNode.gain.value = gainNode.gain.value == -1 ? -.84 : -1;
}

var keys = [0, 0, 0, 0];
document.onkeyup = document.onkeydown = function (e) {
    e.preventDefault();
    var code = e.keyCode-37;
    if (e.type == "keyup") {
        keys[code] = 0;
        if (code == 40) switchMusic();
    } else {
        keys[code] = 1;
    }
    if (gameIsOver) {
        pause(gameState = SI, 1000);
    }
}

title = $("title");
screen = $("screen");
pause(function() {
    initSound();
    
    gameState = SI;
}, 3500);

gameLoop();
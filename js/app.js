/*
 * Wires everything together: controls in the window sill, the settings
 * panel, the render loop, lightning and input on the glass.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'rainy-window.settings.v4';
  const OLD_KEY = 'rainy-window.settings.v3';

  const TRACKS = {
    track1: 'assets/music/rain-music1.mp3',
    track2: 'assets/music/rain-music2.mp3'
  };

  const DEFAULTS = {
    scene: 'photo',
    intensity: 55,
    fog: 50,
    drops: 100,         // water on the glass: 0 off, 50 low, 100 normal
    storm: 0,
    dropSize: 100,
    condensation: 60,
    blur: 10,
    refraction: 60,
    brightness: 90,
    quality: 'high',
    volume: 70,
    muted: false,
    music: 'track1',
    rainSound: false,   // the recorded tracks already have rain in them
    rainVol: 50,
    musicVol: 52,
    thunderVol: 40,
    wood: 'classic',
    grain: true,
    frame: 'framed',    // 'none', 'clean' (sill only) or 'framed'
    advanced: false
  };

  const QUALITY = {
    low: { water: 0.5, dpr: 1 },
    medium: { water: 0.75, dpr: 1.5 },
    high: { water: 1, dpr: 2 }
  };

  const WOODS = [['classic', 'Classic'], ['oak', 'Oak'], ['teak', 'Teak'], ['walnut', 'Walnut'], ['mahogany', 'Mahogany'], ['black', 'Black']];

  function pct(v) { return v + '%'; }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // Fog's default moved from Low to Medium.
        if (!saved.rev && saved.fog === 30) saved.fog = DEFAULTS.fog;
        // Lightning's default moved from Mild to Off.
        if ((saved.rev || 0) < 6 && saved.storm === 6) saved.storm = DEFAULTS.storm;
        // Normal music volume moved down from 65.
        if ((saved.rev || 0) < 7 && saved.musicVol === 65) saved.musicVol = DEFAULTS.musicVol;
        return Object.assign({}, DEFAULTS, saved, { rev: 7 });
      }
      // Carry choices over from the previous version, with the new defaults
      // for wood grain and fog.
      const old = localStorage.getItem(OLD_KEY);
      if (old) {
        const o = JSON.parse(old);
        const fog = o.fogOn === false ? 0 : DEFAULTS.fog;
        const drops = o.dropsOn === false ? 0 : DEFAULTS.drops;
        delete o.fogOn;
        delete o.dropsOn;
        return Object.assign({}, DEFAULTS, o, { grain: true, fog: fog, drops: drops });
      }
    } catch (e) { /* storage unavailable */ }
    return Object.assign({}, DEFAULTS);
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  let settings = load();
  if (!QUALITY[settings.quality]) settings.quality = DEFAULTS.quality;
  if (!Scenes.list.some(function (s) { return s.id === settings.scene; })) settings.scene = DEFAULTS.scene;

  const $ = function (id) { return document.getElementById(id); };
  const canvas = $('view');
  const renderer = new Renderer(canvas);
  if (!renderer.ok) {
    $('fallback').hidden = false;
    $('intro').classList.add('is-hidden');
    return;
  }
  const sim = new RainSim();
  const audio = new AmbientAudio();
  audio.setTracks(TRACKS);
  const bgCanvas = document.createElement('canvas');
  let lights = { count: 0, update: function () {} };
  const lightPos = new Float32Array(Renderer.MAX_LIGHTS * 4);
  const lightCol = new Float32Array(Renderer.MAX_LIGHTS * 3);

  // Normalised settings used by the simulation.
  function simSettings() {
    return {
      intensity: settings.intensity / 100,
      dropSize: settings.dropSize / 100,
      condensation: settings.condensation / 100
    };
  }

  // The same, with "Window drops" applied to how much water reaches the glass.
  function glassSettings() {
    const ss = simSettings();
    const f = settings.drops / 100;
    ss.intensity *= f;
    ss.condensation *= f;
    return ss;
  }

  /* ---------------------------- Layout -------------------------------- */
  let cssW = 0, cssH = 0;
  function resize(force) {
    const w = window.innerWidth, h = window.innerHeight;
    if (!force && w === cssW && h === cssH) return;
    cssW = w; cssH = h;
    const q = QUALITY[settings.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    // Keep the pixel count sane on very large displays.
    const maxPixels = 3200 * 1800;
    let scale = dpr;
    if (w * h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
    renderer.resize(Math.round(w * scale), Math.round(h * scale));
    let waterScale = q.water;
    const maxWater = 2200 * 1300;
    if (w * h * waterScale * waterScale > maxWater) waterScale = Math.sqrt(maxWater / (w * h));
    sim.resize(w, h, waterScale, glassSettings());
    paintScene();
  }

  function paintScene() {
    const q = QUALITY[settings.quality];
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    let bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    const maxW = 2560;
    if (bw > maxW) { bh = Math.round(bh * maxW / bw); bw = maxW; }
    const res = Scenes.create(settings.scene, bgCanvas, Math.max(2, bw), Math.max(2, bh));
    lights = res.lights;
    renderer.blurAmount = settings.blur / 100;
    renderer.setBackground(res.canvas);
  }

  let resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(false); }, 200);
  });

  /* ---------------------------- Lightning ----------------------------- */
  // Mild by default: rare, distant flashes with soft, far-off thunder.
  const storm = { next: Infinity, pulses: [] };
  function scheduleStrike(now) {
    const s = settings.storm / 100;
    if (s <= 0) { storm.next = Infinity; return; }
    const mean = 100 - s * 80; // seconds between strikes
    storm.next = now + (-Math.log(1 - Math.random()) * mean + 8) * 1000;
  }
  function strike(now) {
    const s = settings.storm / 100;
    // Gentle storms stay far away; wild ones can strike close.
    const distance = 1 - Math.random() * Math.min(1, 0.25 + s * 1.3);
    const strength = (1 - distance * 0.6) * (0.25 + 0.75 * s);
    const flickers = 2 + ((Math.random() * 3) | 0);
    let t = now;
    for (let i = 0; i < flickers; i++) {
      storm.pulses.push({ t: t, v: strength * (0.5 + Math.random() * 0.5), decay: 60 + Math.random() * 120 });
      t += 60 + Math.random() * 180;
    }
    const delay = 400 + distance * 5500;
    setTimeout(function () { audio.thunder(distance); }, delay);
  }
  function lightningLevel(now) {
    if (now >= storm.next) {
      strike(now);
      scheduleStrike(now);
    }
    let level = 0;
    storm.pulses = storm.pulses.filter(function (p) {
      const dt = now - p.t;
      if (dt < 0) return true;
      level = Math.max(level, p.v * Math.exp(-dt / p.decay));
      return dt < p.decay * 8;
    });
    return level;
  }

  /* ---------------------------- Main loop ----------------------------- */
  let paused = false;
  let last = performance.now();
  let sceneTime = 0;
  sim.onImpact = function (size, x) { audio.impact(size, x); };

  let waterAmt = 1;
  function frame(now) {
    const dt = Math.min(100, now - last);
    last = now;
    const ss = simSettings();
    // "Window drops": Low lets less water land on the glass; Off dries it
    // quickly and nothing new lands.
    const dropsF = settings.drops / 100;
    waterAmt += ((dropsF > 0 ? 1 : 0) - waterAmt) * Math.min(1, dt / 250);
    if (!paused) {
      updateHold(dt);
      if (dropsF > 0 || waterAmt > 0.01) {
        sim.update(dt, glassSettings());
      }
      sceneTime += dt / 1000;
    }
    sim.draw(ss);
    lights.update(sceneTime, canvas.width / canvas.height, lightPos, lightCol);
    renderer.render({
      water: sim.water,
      fog: sim.fog,
      time: sceneTime,
      refract: 0.25 + (settings.refraction / 100) * 1.5,
      heightScale: sim.rrefPx(ss),
      fogAmt: settings.fog / 100,
      waterAmt: waterAmt,
      lightning: lightningLevel(now) * 0.9,
      rain: settings.intensity / 100,
      brightness: settings.brightness / 100,
      lights: { count: lights.count, pos: lightPos, col: lightCol }
    });
    requestAnimationFrame(frame);
  }

  /* ---------------------------- Controls ------------------------------ */
  // Every control registers a refresh function so the popovers and the
  // advanced panel stay in sync when the same setting changes in either.
  const refreshers = [];
  function refreshAll() { refreshers.forEach(function (r) { r(); }); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  let uid = 0;
  function labelRow(text, forId) {
    const row = el('div', 'ctl__label');
    const l = el('label', '', text);
    if (forId) l.htmlFor = forId;
    row.appendChild(l);
    return row;
  }

  // A row of named choices (e.g. Off / Light / Heavy). `pick` runs when one
  // is chosen; `current` returns the index of the one to light up.
  function choices(label, names, pick, current) {
    const group = el('div', 'seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = names.map(function (n, i) {
      const b = el('button', '', n);
      b.type = 'button';
      b.addEventListener('click', function () { pick(i); });
      group.appendChild(b);
      return b;
    });
    refreshers.push(function () {
      const on = current();
      buttons.forEach(function (b, i) { b.setAttribute('aria-pressed', String(i === on)); });
    });
    return group;
  }

  // Choices that each set one value. A number lights up the nearest choice.
  function seg(key, label, options) {
    const wrap = el('div', 'ctl');
    wrap.appendChild(labelRow(label));
    wrap.appendChild(choices(label, options.map(function (o) { return o[0]; }),
      function (i) { set(key, options[i][1]); },
      function () { return nearest(options, settings[key]); }));
    return wrap;
  }
  function nearest(options, v) {
    let best = 0;
    options.forEach(function (o, i) {
      if (typeof v !== 'number') { if (o[1] === v) best = i; return; }
      if (Math.abs(o[1] - v) < Math.abs(options[best][1] - v)) best = i;
    });
    return best;
  }

  function select(key, label, options) {
    const id = 'ctl-' + key + '-' + (uid++);
    const wrap = el('div', 'ctl');
    wrap.appendChild(labelRow(label, id));
    const s = el('select');
    s.id = id;
    options.forEach(function (o) {
      const opt = el('option', '', o[1]);
      opt.value = o[0];
      s.appendChild(opt);
    });
    s.addEventListener('change', function () { set(key, s.value); });
    wrap.appendChild(s);
    refreshers.push(function () { s.value = settings[key]; });
    return wrap;
  }

  function range(key, label, min, max, fmt) {
    const id = 'ctl-' + key + '-' + (uid++);
    const wrap = el('div', 'ctl');
    const head = labelRow(label, id);
    const val = el('span', 'ctl__val');
    head.appendChild(val);
    wrap.appendChild(head);
    const r = el('input');
    r.type = 'range';
    r.id = id;
    r.min = min;
    r.max = max;
    r.step = 1;
    r.addEventListener('input', function () { set(key, Number(r.value)); });
    wrap.appendChild(r);
    refreshers.push(function () {
      r.value = settings[key];
      val.textContent = (fmt || pct)(settings[key]);
      r.style.setProperty('--pct', ((settings[key] - min) / (max - min)) * 100 + '%');
    });
    return wrap;
  }

  // An on/off switch for a numeric setting: off is 0, on is `onValue`.
  function toggleLevel(key, label, onValue) {
    const t = toggle(null, label, function () { return settings[key] > 0; },
      function (on) { set(key, on ? (settings[key] > 0 ? settings[key] : onValue) : 0); });
    return t;
  }

  function toggle(key, label, get, put) {
    const id = 'ctl-' + key + '-' + (uid++);
    const wrap = el('div', 'ctl ctl--inline');
    const l = el('label', '', label);
    l.htmlFor = id;
    l.style.fontSize = '0.86rem';
    wrap.appendChild(l);
    const sw = el('span', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.id = id;
    input.addEventListener('change', function () { if (put) put(input.checked); else set(key, input.checked); });
    sw.appendChild(input);
    sw.appendChild(el('span'));
    wrap.appendChild(sw);
    refreshers.push(function () { input.checked = get ? get() : !!settings[key]; });
    return wrap;
  }

  function woodPicker() {
    const wrap = el('div', 'ctl');
    wrap.appendChild(labelRow('Frame'));
    const row = el('div', 'swatches');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Frame colour');
    const buttons = WOODS.map(function (w) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.dataset.wood = w[0];
      b.title = w[1];
      b.setAttribute('aria-label', w[1]);
      b.addEventListener('click', function () { set('wood', w[0]); });
      row.appendChild(b);
      return b;
    });
    wrap.appendChild(row);
    refreshers.push(function () {
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.wood === settings.wood)); });
    });
    return wrap;
  }

  function button(text, onClick) {
    const b = el('button', 'btn', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function section(title, children) {
    const s = el('section', 'section');
    if (title) s.appendChild(el('h3', '', title));
    children.forEach(function (c) { s.appendChild(c); });
    return s;
  }

  const LEVELS = {
    music: [['Off', 0], ['Low', 28], ['Normal', 52], ['Higher', 80]],
    rain: [['Off', 0], ['Low', 25], ['Normal', 50], ['Higher', 80]]
  };

  // The main volume, with a mute button at its right end.
  function volumeRow() {
    const wrap = range('volume', 'Volume', 0, 100);
    const r = wrap.querySelector('input');
    const line = el('div', 'vol-line');
    wrap.replaceChild(line, r);
    line.appendChild(r);
    const m = el('button', 'mute');
    m.type = 'button';
    m.innerHTML = knobSound.querySelector('.i-on').outerHTML + knobSound.querySelector('.i-off').outerHTML;
    m.addEventListener('click', function () { set('muted', !settings.muted); });
    line.appendChild(m);
    refreshers.push(function () {
      m.classList.toggle('is-muted', !!settings.muted);
      m.setAttribute('aria-label', settings.muted ? 'Unmute' : 'Mute');
      m.title = settings.muted ? 'Unmute' : 'Mute';
    });
    return wrap;
  }

  const BAR_SCENES = ['photo', 'city', 'harbor'];
  const SHORT_NAMES = { photo: 'Forest', city: 'City', harbor: 'Harbor' };

  const MUSIC = [['track1', 'Rain music 1'], ['track2', 'Rain music 2'], ['ambient', 'Ambient piano'], ['none', 'No music']];

  let pauseBtn = null;
  function buildUI() {
    // Rain & view popover: the essentials, as simple choices, in two columns.
    const rainPop = $('pop-rain');
    rainPop.innerHTML = '';
    rainPop.classList.add('pop--wide');
    const colA = el('div', 'pop__col');
    colA.appendChild(select('scene', 'Scene', Scenes.list.map(function (s) { return [s.id, s.name]; })));
    colA.appendChild(seg('intensity', 'Rain', [['Off', 0], ['Light', 30], ['Medium', 55], ['Heavy', 85]]));
    colA.appendChild(seg('storm', 'Lightning', [['Off', 0], ['Mild', 6], ['Stormy', 55]]));
    const colB = el('div', 'pop__col');
    colB.appendChild(seg('brightness', 'Brightness', [['Dark', 60], ['Low', 75], ['Normal', 90], ['Bright', 100]]));
    colB.appendChild(seg('blur', 'Background blur', [['Clear', 0], ['Normal', 10], ['Distant', 60]]));
    colB.appendChild(seg('fog', 'Window fog', [['Clear', 0], ['Low', 30], ['Medium', 50], ['High', 95]]));
    colB.appendChild(seg('drops', 'Window drops', [['Off', 0], ['Low', 45], ['Normal', 100]]));
    colA.appendChild(seg('frame', 'Frame', [['Frameless', 'none'], ['Clean', 'clean'], ['Framed', 'framed']]));
    rainPop.appendChild(colA);
    rainPop.appendChild(colB);

    // Sound popover.
    const soundPop = $('pop-sound');
    soundPop.innerHTML = '';
    soundPop.appendChild(select('music', 'Music', MUSIC));
    soundPop.appendChild(seg('musicVol', 'Music volume', LEVELS.music));
    // Off here switches the rain sounds off; any level switches them on.
    const rainLv = el('div', 'ctl');
    rainLv.appendChild(labelRow('Rain sounds'));
    rainLv.appendChild(choices('Rain sounds', LEVELS.rain.map(function (o) { return o[0]; }),
      function (i) {
        if (i === 0) { set('rainSound', false); return; }
        settings.rainVol = LEVELS.rain[i][1];
        set('rainSound', true);
        applyVolumes();
      },
      function () { return settings.rainSound ? Math.max(1, nearest(LEVELS.rain, settings.rainVol)) : 0; }));
    soundPop.appendChild(rainLv);
    soundPop.appendChild(volumeRow());

    // Scene switcher in the sill, shown while the pointer is on it.
    const bar = $('scene-bar');
    bar.innerHTML = '';
    bar.appendChild(choices('Scene', BAR_SCENES.map(function (id) { return SHORT_NAMES[id]; }),
      function (i) { set('scene', BAR_SCENES[i]); },
      function () { return BAR_SCENES.indexOf(settings.scene); }));

    // Settings panel.
    const body = $('panel-body');
    body.innerHTML = '';
    pauseBtn = button(paused ? 'Resume rain' : 'Pause rain', togglePause);
    const howTo = el('p', 'howto');
    howTo.innerHTML = 'Tap to add drops.<br>Drag to wipe fog';
    body.appendChild(howTo);
    body.appendChild(section('', [
      seg('quality', 'Quality', [['Low', 'low'], ['Medium', 'medium'], ['High', 'high']]),
      woodPicker(),
      toggle('grain', 'Wood grain'),
      toggleLevel('storm', 'Lightning & thunder', 6),
      (function () { const r = el('div', 'row'); r.appendChild(button('Fullscreen', toggleFullscreen)); r.appendChild(pauseBtn); return r; })()
    ]));
    body.appendChild(section('View', [
      range('intensity', 'Rain intensity', 0, 100),
      range('fog', 'Window fog', 0, 100, function (v) { return v === 0 ? 'Clear' : v + '%'; }),
      range('blur', 'Background blur', 0, 100),
      range('brightness', 'Brightness', 50, 150)
    ]));
    body.appendChild(section('Sound levels', [
      range('musicVol', 'Music', 0, 100),
      range('rainVol', 'Rain sounds', 0, 100),
      range('thunderVol', 'Thunder', 0, 100)
    ]));
    body.appendChild(toggle('advanced', 'Advanced settings'));

    const adv = el('div', 'advanced');
    adv.appendChild(section('', [
      range('dropSize', 'Drop size', 50, 200),
      range('condensation', 'Condensation', 0, 100),
      range('refraction', 'Refraction', 0, 100),
      range('storm', 'Lightning', 0, 100, function (v) { return v === 0 ? 'Off' : v + '%'; })
    ]));
    body.appendChild(adv);
    refreshers.push(function () { adv.hidden = !settings.advanced; });

    const help = el('p', 'help');
    help.innerHTML = 'Tap the glass to add a drop, or hold to grow a bigger one. Press and drag to wipe it.<br>' +
      '<kbd>S</kbd> settings · <kbd>M</kbd> mute · <kbd>F</kbd> fullscreen · <kbd>Space</kbd> pause · <kbd>H</kbd> hide controls';
    body.appendChild(section('Tips', [help, (function () {
      const r = el('div', 'row');
      r.appendChild(button('Reset to defaults', resetAll));
      return r;
    })()]));
    refreshAll();
  }

  function set(key, value) {
    settings[key] = value;
    // The recorded tracks already have rain in them, so their own rain
    // sounds switch off with them (and back on for the other choices).
    if (key === 'music') settings.rainSound = !TRACKS[value];
    save();
    apply(key);
    refreshAll();
  }

  let blurRaf = 0;
  function apply(key) {
    switch (key) {
      case 'scene':
        paintScene();
        break;
      case 'blur':
        cancelAnimationFrame(blurRaf);
        blurRaf = requestAnimationFrame(function () { renderer.setBlur(settings.blur / 100); });
        break;
      case 'quality':
      case 'dropSize':
        resize(true);
        break;
      case 'wood':
      case 'grain':
      case 'frame':
        applyWood();
        break;
      case 'muted':
        audio.setMuted(settings.muted);
        updateSoundKnob();
        break;
      case 'storm':
        scheduleStrike(performance.now());
        break;
      case 'intensity':
        audio.setIntensity(settings.intensity / 100);
        break;
      case 'music':
        audio.setMusic(settings.music);
        audio.setRainSound(settings.rainSound);
        break;
      case 'rainSound':
        audio.setRainSound(settings.rainSound);
        break;
      case 'volume': case 'musicVol': case 'rainVol': case 'thunderVol':
        applyVolumes();
        break;
    }
  }

  function applyWood() {
    $('frame').dataset.wood = settings.wood;
    $('frame').classList.toggle('grain', !!settings.grain);
    document.body.dataset.frame = settings.frame;
  }

  function applyVolumes() {
    audio.setVolumes({
      master: settings.volume / 100,
      music: settings.musicVol / 100,
      rain: settings.rainVol / 100,
      thunder: settings.thunderVol / 100
    });
  }

  function resetAll() {
    const prev = settings;
    settings = Object.assign({}, DEFAULTS, { advanced: prev.advanced, muted: prev.muted });
    save();
    applyWood();
    applyVolumes();
    audio.setIntensity(settings.intensity / 100);
    audio.setMusic(settings.music);
    audio.setRainSound(settings.rainSound);
    scheduleStrike(performance.now());
    if (prev.quality !== settings.quality || prev.dropSize !== settings.dropSize) resize(true);
    else { paintScene(); }
    refreshAll();
  }

  function togglePause() {
    paused = !paused;
    if (pauseBtn) pauseBtn.textContent = paused ? 'Resume rain' : 'Pause rain';
  }

  function toggleFullscreen() {
    const d = document;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) {
      const root = d.documentElement;
      const req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) {
        const r = req.call(root);
        if (r && r.catch) r.catch(function () { /* not allowed here */ });
      }
    } else {
      (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d);
    }
  }

  /* ---------------------------- Popovers & panel ---------------------- */
  const panel = $('panel');
  const knobSettings = $('knob-settings');
  const knobSound = $('knob-sound');
  const pops = [
    { wrap: $('wrap-rain'), knob: $('knob-rain'), pop: $('pop-rain') },
    { wrap: $('wrap-sound'), knob: $('knob-sound'), pop: $('pop-sound') }
  ];

  function setPop(p, open) {
    p.pop.classList.toggle('is-open', open);
    p.knob.setAttribute('aria-expanded', String(open));
  }
  function closePops(except) { pops.forEach(function (p) { if (p !== except) setPop(p, false); }); }

  const hoverable = window.matchMedia('(hover: hover)').matches;
  pops.forEach(function (p) {
    let timer = 0;
    if (hoverable) {
      // Expand on hover, linger briefly so the pointer can move onto it.
      p.wrap.addEventListener('mouseenter', function () {
        clearTimeout(timer);
        if (panel.classList.contains('is-open')) return;
        closePops(p);
        setPop(p, true);
      });
      p.wrap.addEventListener('mouseleave', function () {
        timer = setTimeout(function () {
          if (!p.wrap.contains(document.activeElement) || document.activeElement === p.knob) setPop(p, false);
        }, 300);
      });
    }
    p.knob.addEventListener('click', function () {
      if (panel.classList.contains('is-open')) setPanel(false);
      const isOpen = p.pop.classList.contains('is-open');
      // The speaker mutes on click. On touch screens the first tap opens its
      // popover, and a tap while it's open mutes.
      if (p.knob === knobSound && (hoverable || isOpen)) {
        if (!gestureStartedSound) set('muted', !settings.muted);
        closePops(p);
        setPop(p, true);
        return;
      }
      closePops(p);
      setPop(p, !isOpen || hoverable);
    });
  });

  function setPanel(open) {
    panel.classList.toggle('is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    knobSettings.setAttribute('aria-expanded', String(open));
    if (open) { closePops(); document.body.classList.remove('ui-hidden'); }
  }
  knobSettings.addEventListener('click', function () { setPanel(!panel.classList.contains('is-open')); });
  $('btn-close').addEventListener('click', function () { setPanel(false); });
  $('btn-back').addEventListener('click', function () { setPanel(false); });

  // Clicking anywhere else closes the popovers.
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest('.knob-wrap')) closePops();
  });

  // Show the icons while the pointer is over the frame.
  const frameLeft = document.querySelector('.frame__left');
  const frameSill = document.querySelector('.frame__sill');
  window.addEventListener('pointermove', function (e) {
    const fw = frameLeft.getBoundingClientRect().width;
    const sill = frameSill.getBoundingClientRect().height;
    const onFrame = e.clientX < fw || e.clientX > cssW - fw || e.clientY < fw || e.clientY > cssH - sill;
    document.body.classList.toggle('frame-hot', onFrame || !!e.target.closest('.knobs'));
    if (e.pointerType === 'mouse') {
      document.body.classList.toggle('sill-hot', e.clientY > cssH - Math.max(sill, 64));
    }
  }, { passive: true });
  document.addEventListener('pointerleave', function () { document.body.classList.remove('frame-hot', 'sill-hot'); });
  // On touch screens, a tap on the sill shows the scene switcher for a while.
  let sillTimer = 0;
  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse') return;
    const sill = frameSill.getBoundingClientRect().height;
    const onSill = e.clientY > cssH - Math.max(sill, 64);
    if (!onSill && !e.target.closest('#scene-bar')) return;
    document.body.classList.add('sill-hot');
    clearTimeout(sillTimer);
    sillTimer = setTimeout(function () { document.body.classList.remove('sill-hot'); }, 4000);
  }, { passive: true });

  // A normal cursor that hides after 5 seconds without movement, and turns
  // into a pointing hand while the mouse button is held on the glass.
  let idleTimer = 0;
  function poke() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 5000);
  }
  ['pointermove', 'pointerdown', 'keydown'].forEach(function (e) { window.addEventListener(e, poke, { passive: true }); });
  window.addEventListener('pointerdown', function () { document.body.classList.add('pressing'); }, { passive: true });
  ['pointerup', 'pointercancel', 'blur'].forEach(function (e) {
    window.addEventListener(e, function () { document.body.classList.remove('pressing'); }, { passive: true });
  });

  /* ---------------------------- Sound --------------------------------- */
  // Sound is on by default. Browsers hold it back until the first tap,
  // click or key press.
  function updateSoundKnob() {
    knobSound.classList.toggle('is-muted', audio.muted);
    const verb = audio.muted ? 'unmute' : 'mute';
    knobSound.title = audio.muted ? 'Unmute' : 'Mute';
    knobSound.setAttribute('aria-label', 'Sound (click to ' + verb + ')');
  }
  // A press that was needed to let sound start shouldn't also mute it.
  let gestureStartedSound = false;
  window.addEventListener('pointerdown', function () { gestureStartedSound = audio.isBlocked(); }, { passive: true, capture: true });
  ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'click'].forEach(function (e) {
    window.addEventListener(e, function () {
      audio.start();
      setTimeout(updateSoundKnob, 300);
    }, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    last = performance.now();
    if (!document.hidden) audio.unlock();
  });
  setInterval(updateSoundKnob, 1000);

  /* ------------------- Tap to add water, drag to wipe ---------------- */
  const intro = $('intro');
  const DRAG_START = 10; // px of movement before a press becomes a wipe
  const HOLD_START = 220; // ms of holding still before a drop starts to grow
  let press = null;
  canvas.addEventListener('pointerdown', function (e) {
    if (panel.classList.contains('is-open')) { setPanel(false); return; }
    press = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, id: e.pointerId, wiping: false, t0: performance.now(), drop: null };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!press || press.id !== e.pointerId) return;
    if (!press.wiping) {
      if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) < DRAG_START) return;
      press.wiping = true;
      releaseHold();
    }
    sim.wipe(press.x, press.y, e.clientX, e.clientY, wipeRadius());
    press.x = e.clientX;
    press.y = e.clientY;
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!press || press.id !== e.pointerId) return;
    if (!press.wiping && !press.drop) sim.addWater(press.x0, press.y0, simSettings());
    releaseHold();
    press = null;
  });
  canvas.addEventListener('pointercancel', function (e) {
    if (press && press.id === e.pointerId) { releaseHold(); press = null; }
  });
  // Called every frame: a press held still grows a drop under it.
  function updateHold(dt) {
    if (!press || press.wiping) return;
    if (!press.drop) {
      if (performance.now() - press.t0 < HOLD_START) return;
      press.drop = sim.startHold(press.x0, press.y0, simSettings());
    }
    sim.growHold(press.drop, dt, simSettings());
  }
  function releaseHold() {
    if (press && press.drop) sim.endHold(press.drop);
  }
  function wipeRadius() { return Math.max(18, Math.min(34, Math.min(cssW, cssH) * 0.03)); }

  /* ---------------------------- Keyboard ------------------------------ */
  window.addEventListener('keydown', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') && e.key !== 'Escape') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 's': setPanel(!panel.classList.contains('is-open')); break;
      case 'escape': setPanel(false); closePops(); break;
      case 'm': set('muted', !settings.muted); break;
      case 'f': toggleFullscreen(); break;
      case 'h': document.body.classList.toggle('ui-hidden'); break;
      case ' ':
        if (e.target === document.body) { e.preventDefault(); togglePause(); }
        break;
    }
  });

  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', function () { location.reload(); });

  /* ---------------------------- Boot ---------------------------------- */
  buildUI();
  applyWood();
  resize(true);
  // Repaint once the photo backdrop has decoded.
  Scenes.whenReady(function () { if (settings.scene === 'photo') paintScene(); });
  scheduleStrike(performance.now());

  // Try to start sound straight away; most browsers wait for a first tap.
  audio.setMusic(settings.music);
  audio.setRainSound(settings.rainSound);
  audio.setIntensity(settings.intensity / 100, true);
  audio.setMuted(settings.muted);
  applyVolumes();
  audio.start();
  updateSoundKnob();

  // The title drifts away on its own.
  setTimeout(function () { intro.classList.add('is-hidden'); }, 2600);
  setTimeout(function () { intro.hidden = true; }, 5000);
  requestAnimationFrame(function (t) { last = t; frame(t); });
})();

# Rainy Window

A realistic rain-on-the-window simulation for the browser, with ambient rain sounds, thunder and calming generative music.

## Run it

It's a static site with no build step and no dependencies:

- Serve the folder: `python3 -m http.server`, then visit <http://localhost:8000>, **or**
- Open `index.html` directly in a browser.

Sound is on by default and fades in gently. Browsers only allow a page to play sound after you interact with it, so if it's silent at first, tap or click anywhere. The sound ring in the window sill gently pulses while it's waiting for that tap.

## What's simulated

- **Water on the glass.** Drops land, sit, merge with their neighbours and, once heavy enough, slide down in a stick-slip motion. Running drops stretch into teardrops, sweep up the droplets in their path and leave a trail of beads behind them.
- **Condensation and fog.** Fine droplets build up across the pane and slowly evaporate. The "Window fog" slider sets how misted the glass is, from clear to fully fogged. Running drops wipe clear channels through the mist, and it slowly creeps back.
- **Optics.** The glass is stored as a height map, and a WebGL shader turns it into surface normals. Each drop acts as a lens that shows a sharp, upside-down view of the out-of-focus scene behind it, with dark rims and specular glints.
- **Outside.** The default view is a forest photo. There are also three hand-painted procedural scenes: City at night (with moving traffic), Misty forest and Harbor at dusk (with bobbing boats and a lighthouse). Rain falls in the distance, and lightning flashes are followed by thunder whose delay depends on how far away the strike is.
- **Sound.** By default a recorded rain music track plays. The rest is synthesized live with the Web Audio API: layered rain noise with gusts, drops tapping the pane (some synced to drops landing on screen), drips, rolling thunder, and an optional ambient piece of pad chords and a sparse piano-like melody through reverb.

## Controls

Three rings are set into the bottom of the window frame. Their icons appear when the pointer is over the frame.

- **Rain** (drop icon): what's outside (the forest photo or one of three painted scenes), plus simple choices for rain, window fog and lightning.
- **Sound** (speaker icon): the music (two recorded rain tracks, generated ambient piano, or none), the volume, and a rain sounds switch. The recorded tracks already have rain in them, so choosing one switches the rain sounds off. You can switch them back on.
- **Settings** (gear icon): frame colour (oak, teak, walnut, mahogany or black), fullscreen, pause, and **Advanced settings**, which reveals fine sliders for the rain, the view and the separate sound levels.

On the glass, **tap** to add a drop and **press and drag** to wipe it. Keys: `S` settings, `M` mute, `F` fullscreen, `Space` pause, `H` hide the controls.

## Files

| File | Purpose |
| --- | --- |
| `js/simulation.js` | Drop physics, condensation and fog layers (2D canvas height map) |
| `js/renderer.js` | WebGL refraction, blur, bokeh, fog and lightning shader |
| `js/scenes.js` | Procedurally painted backdrops and animated lights |
| `js/audio.js` | Procedural rain, thunder and music |
| `js/app.js` | Controls, settings, render loop, input |
| `js/background-data.js` | The forest photo, embedded so it also works when opened from disk |
| `assets/` | The forest photo and the two music tracks |

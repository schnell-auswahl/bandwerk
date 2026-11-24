# Site diagrams

The curves on the landing page (`site/index.html`) are computed from the firmware's own formulas, not drawn by hand:
`plots.py` reimplements the relevant parts of `firmware/dsp/` (RBJ biquads at 48 kHz, LR4 crossover, compressor static
curve with auto makeup and parallel dry/wet, the drive shapers and tone tilt, the octaver paths, band mix, master and
soft clip) and returns each diagram as an inline SVG string. `pedal.py` draws the hero pedal (`site/img/pedal.svg`) and
the favicon. `og.html` is the source of the social preview image `site/img/og.png` (copy it to a subfolder of `site/`, so that `../css` resolves, serve `site/` and render it at 1200×630 with a
headless browser).

`site/index.html` is the source of truth. When a formula or default in the firmware changes, regenerate the affected
diagram and paste it over the old `<svg>` in `index.html`:

```sh
cd tools/site_diagrams
python3 -c "import plots; print(plots.all_plots()['plot-comp'])"     # names: python3 -c "import plots; print(sorted(plots.all_plots()))"
```

# Rodillo Fer

Web app to ride structured workouts on an Elite Suito (FTMS, ERG mode) with a Bluetooth heart rate sensor, and export the ride as a FIT file for GoldenCheetah.

- Open `index.html` over HTTPS in a browser with Web Bluetooth (Chrome/Edge on desktop, Bluefy on iPhone/iPad).
- Sources live in `src/`; run `python3 build.py` to inline them into `dist/index.html`, then copy it to `index.html`.

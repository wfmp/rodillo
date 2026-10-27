"""Inline the app sources into a single self-contained index.html."""
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "src"
DIST = ROOT / "dist"


def build():
    html = (SRC / "index.template.html").read_text(encoding="utf-8")
    replacements = {
        "/*PLAN_JSON*/": (SRC / "plan.json").read_text(encoding="utf-8").strip(),
        "/*FIT_JS*/": (SRC / "fit.js").read_text(encoding="utf-8"),
        "/*WORKOUTS_JS*/": (SRC / "workouts.js").read_text(encoding="utf-8"),
        "/*BLE_JS*/": (SRC / "ble.js").read_text(encoding="utf-8"),
        "/*DROPBOX_JS*/": (SRC / "dropbox.js").read_text(encoding="utf-8"),
        "/*ANALYSIS_JS*/": (SRC / "analysis.js").read_text(encoding="utf-8"),
        "/*HISTORY_JS*/": (SRC / "history.js").read_text(encoding="utf-8"),
        "/*FITPARSE_JS*/": (SRC / "fitparse.js").read_text(encoding="utf-8"),
        "/*CHART_JS*/": (SRC / "chart.js").read_text(encoding="utf-8"),
        "/*VIEWS_JS*/": (SRC / "views.js").read_text(encoding="utf-8"),
        "/*APP_JS*/": (SRC / "app.js").read_text(encoding="utf-8"),
    }
    for marker, content in replacements.items():
        if marker not in html:
            raise ValueError(f"Marker {marker} missing from template")
        html = html.replace(marker, content)
    DIST.mkdir(exist_ok=True)
    out = DIST / "index.html"
    out.write_text(html, encoding="utf-8")
    return out


if __name__ == "__main__":
    path = build()
    print(path, path.stat().st_size, "bytes")

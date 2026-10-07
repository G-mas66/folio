"""Export the shared SVG mark to the Windows and renderer raster assets."""
from pathlib import Path

import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
svg = (ROOT / "public" / "folio-mark.svg").read_bytes()
source = fitz.open(stream=svg, filetype="svg")
pdf = fitz.open(stream=source.convert_to_pdf(), filetype="pdf")
png_path = ROOT / "assets" / "folio-icon.png"
ico_path = ROOT / "assets" / "folio-icon.ico"
png_path.parent.mkdir(parents=True, exist_ok=True)
pdf[0].get_pixmap(matrix=fitz.Matrix(1, 1), alpha=True).save(png_path)
with Image.open(png_path) as image:
    image.save(ico_path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

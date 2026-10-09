"""Synthetic PDF with raster, vector chart and columns for layout acceptance."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / '.review' / 'fixtures'
out.mkdir(parents=True, exist_ok=True)
pic = Image.new('RGB', (240, 120), '#e5eef4')
draw = ImageDraw.Draw(pic)
draw.rectangle((20, 20, 95, 100), fill='#205d91')
draw.ellipse((120, 20, 205, 100), fill='#dc783d')
pdf = canvas.Canvas(str(out / 'layout_images.pdf'), pagesize=A4, invariant=True)
pdf.setTitle('Quartz Measurements with Figures')
for index in range(2):
    pdf.setFont('Helvetica-Bold', 17)
    pdf.drawString(48, 790, 'Quartz Measurements with Figures' if index == 0 else 'Results and Appendix')
    pdf.saveState()
    pdf.setFont('Helvetica', 7)
    pdf.translate(17, 340)
    pdf.rotate(90)
    pdf.drawString(0, 0, 'Downloaded by Folio synthetic review only')
    pdf.restoreState()
    for x in (48, 310):
        text = pdf.beginText(x, 753)
        text.setFont('Helvetica', 10)
        text.setLeading(15)
        for line in ['This synthetic paper evaluates', 'quartz measurements in a controlled', 'laboratory experiment. We used', '137 independent samples. The', 'measured signal increased by 23.7%.', 'All figures show synthetic data.']:
            text.textLine(line)
        pdf.drawText(text)
    pdf.drawImage(ImageReader(pic), 48, 420, width=240, height=120)
    pdf.setFont('Helvetica', 10)
    pdf.drawString(48, 400, 'Figure 1. Synthetic raster calibration image.')
    pdf.setStrokeColorRGB(.15, .25, .35)
    pdf.line(335, 430, 335, 550)
    pdf.line(335, 430, 525, 430)
    for x, h, color in [(355, 55, (.2,.5,.7)), (420, 100, (.8,.4,.2))]:
        pdf.setFillColorRGB(*color)
        pdf.rect(x, 430, 40, h, fill=1, stroke=0)
    pdf.setFillColorRGB(0, 0, 0)
    pdf.drawString(310, 400, 'Figure 2. Synthetic vector bar chart.')
    pdf.setFont('Helvetica', 11)
    pdf.drawString(48, 340, 'The data generation seed was 811. No field experiment was performed.')
    pdf.drawString(48, 320, 'The original raster image and vector chart must remain in both versions.')
    for fragment in range(40):
        pdf.setFont('Helvetica' if fragment % 2 == 0 else 'Times-Roman', 6)
        pdf.drawString(48 + fragment * 12, 280, f'{fragment:02d} ')
    pdf.showPage()
pdf.save()
print(out / 'layout_images.pdf')

"""Generate non-sensitive PDFs with known facts for independent acceptance."""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

from review.paths import FIXTURE_ROOT

OUT = FIXTURE_ROOT


def page(pdf, heading, lines):
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(48, 790, heading)
    text = pdf.beginText(48, 758)
    text.setFont("Helvetica", 10)
    text.setLeading(15)
    for line in lines:
        text.textLine(line)
    pdf.drawText(text)
    pdf.showPage()


def paper(name, sample_count, delta, seed):
    pdf = canvas.Canvas(str(OUT / name), pagesize=A4)
    pdf.setTitle("A Study of Quartz Measurements")
    page(pdf, "A Study of Quartz Measurements", [
        "Abstract",
        "This synthetic paper evaluates a measurement method.",
        "The abstract deliberately omits the sample count and numerical result.",
        "Its methods, results and appendix contain facts needed for a detailed summary.",
    ])
    page(pdf, "Methods", [
        f"The controlled experiment used {sample_count} independent samples.",
        f"QUARTZ_METHOD_N={sample_count}",
        "Samples were assigned to a reference group and a treatment group.",
        "The measurement procedure was repeated three times.",
    ])
    page(pdf, "Results and Limitations", [
        f"The treatment increased the measured signal by {delta}%.",
        f"QUARTZ_RESULT_DELTA={delta}%",
        "The result applies only to the laboratory conditions in this paper.",
        "No field experiment was performed.",
    ])
    page(pdf, "Appendix A: Reproducibility", [
        f"The data generation seed was {seed}.",
        f"QUARTZ_APPENDIX_SEED={seed}",
        "This fact is not repeated in the abstract or the main results.",
    ])
    pdf.save()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    paper("quartz_alpha.pdf", 137, "23.7", 811)
    paper("quartz_beta_same_title.pdf", 249, "8.4", 977)

    pdf = canvas.Canvas(str(OUT / "long_paper.pdf"), pagesize=A4)
    pdf.setTitle("Long Document Coverage Test")
    for index in range(1, 25):
        lines = [f"COVERAGE_PAGE_{index:02d}: required section evidence."]
        lines.extend(
            f"Observation {row:02d}: section {index:02d} evaluates repeatable measurements "
            "under fixed laboratory conditions."
            for row in range(1, 43)
        )
        page(pdf, f"Section {index:02d}" if index < 24 else "Appendix", lines)
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "macos_chinese_original.pdf"), pagesize=A4, invariant=1)
    pdf.setTitle("MacOS Chinese Reading Smoke Test")
    pdf.setFont("STSong-Light", 14)
    pdf.drawString(48, 790, "中文测试文献")
    pdf.setFont("STSong-Light", 11)
    for index, line in enumerate((
        "本地测试样本无需翻译，页面内容应能正常阅读。",
        "中文原文直接导入后应显示完整页面，不需要启动翻译引擎。",
        "此合成文献仅用于验证 macOS 桌面版本的阅读与笔记功能。",
    )):
        pdf.drawString(48, 758 - index * 22, line)
    pdf.showPage()
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "macos_translation_sample.pdf"), pagesize=A4, invariant=1)
    pdf.setTitle("MacOS Free Translation Smoke Test")
    page(pdf, "A Short Synthetic Measurement Study", [
        "This synthetic study evaluates a repeatable measurement method.",
        "The method was tested on 137 independent samples.",
        "The measured signal increased by 23.7 percent.",
        "All values in this sample are fictional and created for software testing.",
    ])
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "two_columns.pdf"), pagesize=A4)
    pdf.setTitle("Two Column Extraction Test")
    pdf.setFont("Helvetica-Bold", 16)
    pdf.drawString(48, 790, "Two Column Extraction Test")
    for x, side in [(48, "LEFT"), (310, "RIGHT")]:
        text = pdf.beginText(x, 754)
        text.setFont("Helvetica", 9)
        text.setLeading(15)
        for row in range(1, 35):
            text.textLine(f"{side}_ROW_{row:02d}: paired column evidence.")
        pdf.drawText(text)
    pdf.showPage()
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "no_text_page.pdf"), pagesize=A4)
    pdf.setTitle("Unextractable Page Test")
    # Shapes represent visible page content without a usable text layer.
    for y in range(70, 730, 22):
        pdf.rect(48, y, 490, 8, fill=1, stroke=0)
    pdf.showPage()
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "mixed_text_and_unextractable.pdf"), pagesize=A4)
    pdf.setTitle("Mixed Page Extraction Test")
    page(pdf, "Mixed Page Extraction Test", [
        "Abstract", "The next page contains visible content without usable text.",
    ])
    for y in range(70, 730, 22):
        pdf.rect(48, y, 490, 8, fill=1, stroke=0)
    pdf.showPage()
    pdf.save()

    pdf = canvas.Canvas(str(OUT / "wrong_metadata_title.pdf"), pagesize=A4)
    pdf.setTitle("Generic Export Document")
    page(pdf, "The Actual Quartz Measurement Study", [
        "Alice Example and Bob Example", "Abstract",
        "This paper concerns quartz measurements in laboratory conditions.",
    ])
    pdf.save()

    for item in sorted(OUT.glob("*.pdf")):
        print(item)


if __name__ == "__main__":
    main()

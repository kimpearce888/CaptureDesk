#!/usr/bin/env python3
"""CaptureDesk brand asset generator.

Creates the ORIGINAL CaptureDesk visual identity:
a teal->cyan rounded-square badge containing a white monitor frame
with a recording-dot badge and a small stand. Nothing here is derived
from any other screen-recording product's artwork.

Outputs PNG icons, Windows .ico, and NSIS installer bitmaps.
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Brand palette (original: teal -> deep cyan gradient on dark slate)
C_TOP = (20, 184, 166)      # #14B8A6 teal
C_BOT = (8, 110, 150)       # #086E96 deep cyan
SLATE = (15, 23, 42)        # #0F172A
WHITE = (255, 255, 255)

S = 512  # master size


def hexs(rgb):
    return "#%02X%02X%02X" % rgb


def rounded_gradient_bg(size, radius_frac):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # vertical gradient
    grad = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / (size - 1)
        col = tuple(int(C_TOP[i] + (C_BOT[i] - C_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (size, y)], fill=col)
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    r = int(size * radius_frac)
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_mark(img, scale=1.0):
    """Draw monitor + rec dot + stand, coordinates in 512-space."""
    d = ImageDraw.Draw(img)

    def px(v):  # scale helper
        return v * scale

    lw = px(26)      # frame stroke
    # monitor frame
    d.rounded_rectangle([px(96), px(118), px(416), px(350)], radius=px(34),
                        outline=WHITE, width=int(lw))
    # stand neck
    d.rounded_rectangle([px(234), px(350), px(278), px(412)], radius=px(10), fill=WHITE)
    # stand base
    d.rounded_rectangle([px(172), px(412), px(340), px(438)], radius=px(13), fill=WHITE)
    # separation ring + rec dot (bottom-right, overlapping frame corner)
    ring_c = (392, 342)
    ring_r = px(74)
    d.ellipse([ring_c[0] - ring_r, ring_c[1] - ring_r,
               ring_c[0] + ring_r, ring_c[1] + ring_r], fill=hexs(C_BOT))
    dot_r = px(56)
    d.ellipse([ring_c[0] - dot_r, ring_c[1] - dot_r,
               ring_c[0] + dot_r, ring_c[1] + dot_r], fill=WHITE)
    # inner accent dot (teal) to suggest a record light
    in_r = px(22)
    d.ellipse([ring_c[0] - in_r, ring_c[1] - in_r,
               ring_c[0] + in_r, ring_c[1] + in_r], fill=hexs(C_TOP))
    return img


def make_badge(size):
    img = rounded_gradient_bg(S, 0.22)
    draw_mark(img, 1.0)
    if size != S:
        img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    # ---- desktop icons -------------------------------------------------
    desk_icons = os.path.join(ROOT, "desktop", "assets", "icons")
    os.makedirs(desk_icons, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256, 512]
    pngs = {}
    for s in sizes:
        p = make_badge(s)
        pngs[s] = p
        p.save(os.path.join(desk_icons, f"CaptureDesk_{s}.png"))

    # multi-resolution Windows .ico
    ico_path = os.path.join(desk_icons, "CaptureDesk.ico")
    pngs[256].save(ico_path, format="ICO",
                   sizes=[(s, s) for s in [16, 24, 32, 48, 64, 128, 256]])
    print("wrote", ico_path)

    # ---- extension icons -------------------------------------------------
    ext_icons = os.path.join(ROOT, "extension", "assets", "icons")
    os.makedirs(ext_icons, exist_ok=True)
    for s in [16, 32, 48, 128]:
        make_badge(s).save(os.path.join(ext_icons, f"icon{s}.png"))
    print("wrote extension icons")

    # ---- tray icons ------------------------------------------------------
    tray = os.path.join(desk_icons)
    pngs[32].save(os.path.join(tray, "tray.png"))
    # recording-state tray variant: red dot overlay bottom-right
    rec = pngs[32].copy()
    rd = ImageDraw.Draw(rec)
    rd.ellipse([19, 19, 31, 31], fill=(239, 68, 68, 255))
    rec.save(os.path.join(tray, "tray-rec.png"))

    # ---- NSIS installer bitmaps -----------------------------------------
    inst = os.path.join(ROOT, "installer", "assets")
    os.makedirs(inst, exist_ok=True)

    # vertical welcome sidebar 164x314 (NSIS MUI2 WELCOMEFINISHPAGE BITMAP)
    w, h = 164, 314
    side = Image.new("RGB", (w, h), SLATE)
    sd = ImageDraw.Draw(side)
    for y in range(h):
        t = y / (h - 1)
        col = tuple(int(SLATE[i] + (C_BOT[i] - SLATE[i]) * 0.55 * t) for i in range(3))
        sd.line([(0, y), (w, y)], fill=col)
    badge = pngs[128].resize((96, 96), Image.LANCZOS)
    side.paste(badge, ((w - 96) // 2, 60), badge)
    try:
        f_big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 17)
        f_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 10)
    except Exception:
        f_big = f_small = None
    tw = sd.textlength("CaptureDesk", font=f_big)
    sd.text(((w - tw) / 2, 178), "CaptureDesk", fill=WHITE, font=f_big)
    tw = sd.textlength("Screen Recorder", font=f_small)
    sd.text(((w - tw) / 2, 204), "Screen Recorder", fill=(148, 233, 224), font=f_small)
    side.save(os.path.join(inst, "sidebar.bmp"))

    # header bitmap 150x57
    hw, hh = 150, 57
    head = Image.new("RGB", (hw, hh), SLATE)
    hd = ImageDraw.Draw(head)
    for x in range(hw):
        t = x / (hw - 1)
        col = tuple(int(SLATE[i] + (C_BOT[i] - SLATE[i]) * 0.5 * t) for i in range(3))
        hd.line([(x, 0), (x, hh)], fill=col)
    b36 = pngs[32].resize((36, 36), Image.LANCZOS)
    head.paste(b36, (10, 10), b36)
    hd.text((54, 20), "CaptureDesk", fill=WHITE, font=f_big)
    head.save(os.path.join(inst, "header.bmp"))
    print("wrote installer bitmaps")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Programmatic visual critique of FORM/0 screenshots.
- OCR orientation test (detects flipped/upside-down post content)
- Composition: dead space, brightness, contrast, colorfulness per region
- Card detection + per-card stats
"""
import sys, subprocess, os
import numpy as np
import cv2
from PIL import Image

SHOTS = sys.argv[1:] or ["shots/board_top.png", "shots/board_mid.png", "shots/viewer.png",
                         "shots/viewer_meta.png", "shots/thread.png", "shots/settings.png"]

def ocr_stats(img: np.ndarray, name=""):
    """Run tesseract on image bytes; return (text, mean_conf)."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        cv2.imwrite(f.name, img)
        p = f.name
    out = subprocess.run(
        ["tesseract", p, "stdout", "--psm", "11", "2>/dev/null"],
        capture_output=True, text=True)
    os.unlink(p)
    text = out.stdout.strip()
    # second pass with TSV for confidence
    out2 = subprocess.run(
        ["tesseract", p, "stdout", "--psm", "11", "tsv", "2>/dev/null"],
        capture_output=True, text=True)
    confs = []
    for line in out2.stdout.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) > 10 and parts[10].strip():
            try:
                c = float(parts[10])
                if c > 0: confs.append(c)
            except ValueError:
                pass
    mean = np.mean(confs) if confs else 0.0
    return text.replace("\n", " ")[:200], round(float(mean), 1), len(confs)

def region_stats(img: np.ndarray, grid=(3, 3)):
    """Per-region mean brightness, std (contrast proxy), colorfulness."""
    h, w = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    rows = []
    for gy in range(grid[0]):
        row = []
        for gx in range(grid[1]):
            y0, y1 = int(h * gy / grid[0]), int(h * (gy + 1) / grid[0])
            x0, x1 = int(w * gx / grid[1]), int(w * (gx + 1) / grid[1])
            cell = g[y0:y1, x0:x1]
            v = cell[:, :, 2]
            s = cell[:, :, 1]
            row.append(f"V{v.mean():3.0f}/S{s.mean():2.0f}/sd{v.std():3.0f}")
        rows.append(" ".join(row))
    return rows

def main():
    for shot in SHOTS:
        if not os.path.exists(shot):
            print(f"!! missing {shot}")
            continue
        img = cv2.imread(shot)
        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        print(f"\n{'='*70}\n{shot}  {w}x{h}")
        print(f"brightness {gray.mean():.0f}  contrast(std) {gray.std():.0f}  "
              f"colorfulness {cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:,:,1].mean():.0f}")
        print("grid (brightness/saturation/std):")
        for row in region_stats(img):
            print("  " + row)
        # orientation test: which rotation OCRs best?
        variants = {
            "normal": img,
            "rot180": cv2.rotate(img, cv2.ROTATE_180),
            "flipH (mirrored)": cv2.flip(img, 1),
            "rot90": cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE),
        }
        print("OCR orientation test:")
        for name, v in variants.items():
            text, conf, n = ocr_stats(v)
            print(f"  {name:18s} conf={conf:5.1f} words={n:3d}  '{text[:80]}'")

if __name__ == "__main__":
    main()

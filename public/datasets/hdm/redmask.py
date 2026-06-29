#!/usr/bin/env python3
"""Keep red HdM letters, set everything else to black."""
import sys, glob, os
from PIL import Image, ImageChops

def red_mask(img):
    h, s, v = img.convert("HSV").split()
    # red hue wraps around 0/255; require strong saturation and some brightness
    hue = h.point(lambda p: 255 if (p < 16 or p > 239) else 0).convert("1")
    sat = s.point(lambda p: 255 if p > 90 else 0).convert("1")
    val = v.point(lambda p: 255 if p > 45 else 0).convert("1")
    mask = ImageChops.logical_and(ImageChops.logical_and(hue, sat), val)
    return mask

def process(path, outpath):
    img = Image.open(path).convert("RGB")
    mask = red_mask(img)
    black = Image.new("RGB", img.size, (0, 0, 0))
    out = Image.composite(img, black, mask)
    out.save(outpath, quality=95)

if __name__ == "__main__":
    files = sys.argv[1:]
    for f in files:
        out = f.rsplit(".", 1)[0] + "_masked.jpg"
        process(f, out)
        print("wrote", out)

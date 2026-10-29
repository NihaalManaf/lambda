# Turns a generated still of a sphere (a globe on a pedestal) into a spinning stop-motion strip: the sphere
# is found in the image, a flat equirectangular texture is projected onto it frame by frame, and the still's
# own light (its luminance, blurred until the carving is gone) shades the projection. Everything outside
# the sphere stays the generated pixels. See style.md → loaders.
# usage: python3 -I scripts/art/spin.py still.png texture.png out.webp [frames=24] [height=240] [contrast=2]
import sys

import numpy as np
from PIL import Image, ImageFilter

still_p, tex_p, out_p = sys.argv[1:4]
N = int(sys.argv[4]) if len(sys.argv) > 4 else 24
HEIGHT = int(sys.argv[5]) if len(sys.argv) > 5 else 240
CONTRAST = float(sys.argv[6]) if len(sys.argv) > 6 else 2.0  # carved relief reads faint once small: push land off sea
SS = 2  # supersample the sphere for clean carved edges

im = np.asarray(Image.open(still_p).convert("RGBA")).astype(np.float32)
A = im[..., 3]
H, W = A.shape

# sphere = the widest solid row in the top half (its equator); pedestal is narrower and below
rows = A > 128
widths = rows.sum(1)
top = int(np.argmax(widths > 0))
half = top + (np.nonzero(widths)[0][-1] - top) // 2
eq = top + int(np.argmax(widths[top:half]))
xs = np.nonzero(rows[eq])[0]
r = (xs[-1] - xs[0] + 1) / 2
cx = (xs[-1] + xs[0]) / 2
cy = top + r
print(f"sphere: c=({cx:.0f},{cy:.0f}) r={r:.0f}")

# light: luminance of the still's sphere, blurred well past the carved relief, normalised around its mean
lum = Image.fromarray(im[..., :3].mean(2).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r * 0.12))
lum = np.asarray(lum).astype(np.float32)

tex = Image.open(tex_p).convert("RGB")
tw = tex.width
# wrap seam: cross-fade the outer 4% of each side so lon -180 meets +180
t = np.asarray(tex).astype(np.float32)
k = int(tw * 0.04)
ramp = np.linspace(0, 1, k)[None, :, None]
t[:, :k] = t[:, :k] * ramp + t[:, -k:] * (1 - ramp)
t = t[:, : tw - k]
sea = np.median(t, axis=(0, 1))
t = np.clip(sea + (t - sea) * CONTRAST, 0, 255)
th, tw = t.shape[:2]

# sphere pixel grid at SS×
y0, y1 = int(cy - r) - 2, int(cy + r) + 3
x0, x1 = int(cx - r) - 2, int(cx + r) + 3
gy, gx = np.mgrid[y0 * SS : y1 * SS, x0 * SS : x1 * SS].astype(np.float32) / SS + 0.5 / SS
nx, ny = (gx - cx) / r, (gy - cy) / r
d2 = nx**2 + ny**2
inside = d2 < 1
nz = np.sqrt(np.clip(1 - d2, 0, 1))
lat = np.arcsin(np.clip(-ny, -1, 1))
v = np.clip((0.5 - lat / np.pi) * (th - 1), 0, th - 1)
lon0 = np.arctan2(nx, nz)

# shade = the still's light at this pixel / the light at the sphere's centre-ish (keeps ivory, not grey)
shade = lum[np.clip(gy.astype(int), 0, H - 1), np.clip(gx.astype(int), 0, W - 1)]
shade = shade / np.percentile(shade[inside], 90)
# the pedestal's cup covers the bottom of the sphere: only replace where the still is sphere, not cup
keep = inside & (A[np.clip(gy.astype(int), 0, H - 1), np.clip(gx.astype(int), 0, W - 1)] > 8)


def chroma_cap(px, cap=16):
    l = px.mean(-1, keepdims=True)
    spread = px.max(-1, keepdims=True) - px.min(-1, keepdims=True)
    k = np.where(spread > cap, cap / np.maximum(spread, 1), 1)
    return l + (px - l) * k


# crop: sphere + pedestal, square-ish, with the still's own margin
ys_, xs_ = np.nonzero(A > 8)
m = int(r * 0.06)
cb = (max(xs_.min() - m, 0), max(ys_.min() - m, 0), min(xs_.max() + m + 1, W), min(ys_.max() + m + 1, H))

frames = []
for f in range(N):
    lon = lon0 - 2 * np.pi * f / N  # surface moves left → right: eastward, like the earth
    u = ((lon / (2 * np.pi) + 0.5) % 1) * (tw - 1)
    ui, vi = u.astype(int), v.astype(int)
    fu, fv = (u - ui)[..., None], (v - vi)[..., None]
    u1, v1 = np.minimum(ui + 1, tw - 1), np.minimum(vi + 1, th - 1)
    c = (t[vi, ui] * (1 - fu) * (1 - fv) + t[vi, u1] * fu * (1 - fv) + t[v1, ui] * (1 - fu) * fv + t[v1, u1] * fu * fv)
    c = chroma_cap(c * shade[..., None])
    # down-sample the SS× patch with coverage as alpha weight
    h, w = (y1 - y0), (x1 - x0)
    cov = keep.astype(np.float32).reshape(h, SS, w, SS).mean((1, 3))
    col = (c * keep[..., None]).reshape(h, SS, w, SS, 3).sum((1, 3)) / np.maximum(keep.reshape(h, SS, w, SS).sum((1, 3)), 1)[..., None]
    out = im.copy()
    patch = out[y0:y1, x0:x1, :3]
    out[y0:y1, x0:x1, :3] = patch * (1 - cov[..., None]) + col * cov[..., None]
    out[..., :3] = chroma_cap(out[..., :3])
    fr = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).crop(cb)
    fr = fr.resize((round(fr.width * HEIGHT / fr.height), HEIGHT), Image.LANCZOS)
    frames.append(fr)

fw = frames[0].width
strip = Image.new("RGBA", (fw * N, HEIGHT), (0, 0, 0, 0))
for i, fr in enumerate(frames):
    strip.paste(fr, (i * fw, 0))
strip.save(out_p, "WEBP", quality=86, alpha_quality=90, method=6)
print(f"{out_p}: {N} frames of {fw}x{HEIGHT}")

# Splits a generated still of separate figures (a frieze) into one transparent webp per figure, left to right,
# all cut to the same height band so they share a ground line. Prints each figure's [left, width] for layout.
# Needs scipy, so run with -P rather than -I (-I drops user site-packages).
# usage: python3 -P scripts/art/split.py still.png out_dir
import sys
import numpy as np
from PIL import Image
from scipy import ndimage
src,out=sys.argv[1:3]
a=np.asarray(Image.open(src).convert("RGBA")).astype(np.float32)
l=a[...,:3].mean(-1,keepdims=True); sp=a[...,:3].max(-1,keepdims=True)-a[...,:3].min(-1,keepdims=True)
a[...,:3]=l+(a[...,:3]-l)*np.where(sp>16,16/np.maximum(sp,1),1)
A=a[...,3]
lab,n=ndimage.label(A>60)
sizes=ndimage.sum(np.ones_like(A),lab,range(1,n+1))
big=[i+1 for i,s in enumerate(sizes) if s>2000]
_,(iy,ix)=ndimage.distance_transform_edt(~np.isin(lab,big),return_indices=True)
owner=lab[iy,ix]
figs=sorted(big,key=lambda k:np.nonzero(lab==k)[1].mean())
ys=np.nonzero(A>10)[0]; y0,y1=ys.min(),ys.max()
H=96; pad=4; k=H/(y1-y0+1+2*pad)
xs=[]
for i,f in enumerate(figs):
    m=(owner==f)&(A>0)
    cx=np.nonzero(m)[1]; x0,x1=cx.min()-pad,cx.max()+1+pad
    b=a.copy(); b[...,3]=np.where(m,A,0)
    c=Image.fromarray(np.clip(b,0,255).astype(np.uint8)).crop((x0,y0-pad,x1,y1+1+pad))
    c=c.resize((round(c.width*k),H),Image.LANCZOS); c.save(f"{out}/{i}.webp","WEBP",quality=88,alpha_quality=90,method=6)
    xs.append((round(x0*k),c.width))
base=xs[0][0]
print(len(figs),"figures; [left, width] at H=96:",[(x-base,w) for x,w in xs])

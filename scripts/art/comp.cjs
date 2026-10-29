const s=require('sharp');
// Composites pose-edit frames onto one base so only the moving part changes (see style.md → loaders).
// usage: comp.cjs spec.json ; spec = {base, crop:{left,top,width,height}, outDir, width, frames:[{name, src?, polys:[[[x,y],...]]}]}
// a frame without src is the base itself; otherwise base pixels everywhere except the feathered polygon union, where src shows
(async()=>{const sp=JSON.parse(require('fs').readFileSync(process.argv[2]));
const rd=async f=>(await s(f).ensureAlpha().raw().toBuffer({resolveWithObject:true}));const B=await rd(sp.base);const W=B.info.width,H=B.info.height;
for(const fr of sp.frames){let px=B.data;
 if(fr.src){const E=await rd(fr.src);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><filter id="f"><feGaussianBlur stdDeviation="${sp.feather||4}"/></filter><g>${fr.polys.map(p=>`<polygon fill="#fff" points="${p.map(q=>q.join(',')).join(' ')}"/>`).join('')}</g></svg>`;
  // auto mask: wherever coverage changed (a limb left or entered empty background), dilated so no fringe of the old pose survives
  const D=Buffer.alloc(W*H);for(let i=0;i<W*H;i++)D[i]=Math.abs(B.data[i*4+3]-E.data[i*4+3])>60?255:0;
  // separable max-filter dilation (sharp's threshold isn't binary on 1-channel raw input)
  const R=sp.dilate||6,T=Buffer.alloc(W*H),Dm=Buffer.alloc(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let v=0;for(let k=Math.max(0,x-R);k<=Math.min(W-1,x+R)&&!v;k++)v=D[y*W+k];T[y*W+x]=v}
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let v=0;for(let k=Math.max(0,y-R);k<=Math.min(H-1,y+R)&&!v;k++)v=T[k*W+x];Dm[y*W+x]=v}
  // polygons are feathered (they cut through stone, where the seam must hide); the coverage mask stays hard (it borders empty background)
  const M=(await s({create:{width:W,height:H,channels:3,background:'#000'}}).composite([{input:Buffer.from(svg)}]).blur(sp.feather||4).extractChannel(0).raw().toBuffer());
  for(let i=0;i<W*H;i++)if(Dm[i]>M[i])M[i]=Dm[i];
  // keep rects: static props the edit dropped (base always wins there)
  for(const [x0,y0,x1,y1] of fr.keep||[])for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)M[y*W+x]=0;
  if(sp.debug)await s(M,{raw:{width:W,height:H,channels:1}}).png().toFile(sp.debug+'-'+fr.name+'.png');
  px=Buffer.alloc(W*H*4);
  for(let i=0;i<W*H;i++){const m=M[i]/255;const ab=B.data[i*4+3]/255,ae=E.data[i*4+3]/255;const a=ab*(1-m)+ae*m;px[i*4+3]=Math.round(a*255);
   for(let c=0;c<3;c++){const v=a>0?(B.data[i*4+c]*ab*(1-m)+E.data[i*4+c]*ae*m)/a:0;px[i*4+c]=Math.round(v)}}}
 // palette guard: cap chroma so nothing leaves the ivory/grey range (edits sometimes tint wood/reed brown)
 const CAP=sp.chroma||16;px=Buffer.from(px);for(let i=0;i<W*H;i++){const r=px[i*4],g=px[i*4+1],b=px[i*4+2];const mx=Math.max(r,g,b),mn=Math.min(r,g,b);if(mx-mn>CAP){const l=(r+g+b)/3,k=CAP/(mx-mn);px[i*4]=Math.round(l+(r-l)*k);px[i*4+1]=Math.round(l+(g-l)*k);px[i*4+2]=Math.round(l+(b-l)*k)}}
 const r=await s(px,{raw:{width:W,height:H,channels:4}}).extract(sp.crop).resize({width:sp.width}).webp({quality:85,alphaQuality:90}).toFile(`${sp.outDir}/${fr.name}.webp`);
 console.log(fr.name,r.width,r.height,(r.size/1024|0)+'KB')}})()

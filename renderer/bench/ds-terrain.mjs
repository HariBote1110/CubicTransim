const f = Math.fround;
const fma = (a, b, c) => f(f(a) * f(b) + f(c));
const add = (a, b) => {
  const s = f(a[0] + b[0]);
  const v = f(s - a[0]);
  let e = f(f(a[0] - f(s - v)) + f(b[0] - v));
  e = f(e + a[1]);
  e = f(e + b[1]);
  const hi = f(s + e);
  const lo = f(e - f(hi - s));
  return [hi, lo];
};
const neg = a => [f(-a[0]), f(-a[1])];
const sub = (a, b) => add(a, neg(b));
const mul = (a, b) => {
  const p = f(a[0] * b[0]);
  let e = fma(a[0], b[0], -p);
  e = f(e + f(a[0] * b[1]));
  e = f(e + f(a[1] * b[0]));
  const hi = f(p + e);
  let lo = f(e - f(hi - p));
  lo = f(lo + f(a[1] * b[1]));
  return [hi, lo];
};
const scalePow2 = (a, s) => [f(a[0] * s), f(a[1] * s)];
const fromNumber = x => { const hi = f(x); return [hi, f(x - hi)]; };
const fromU32Unit = h => [f((h >>> 16) / 65536), f((h & 0xffff) / 4294967296)];
const ratioSmall = (n, d) => {
  const nf = f(n), df = f(d);
  const hi = f(nf / df);
  const residual = fma(hi, df, -nf);
  return [hi, f(-residual / df)];
};
const ge = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

const hashBits = (seed, x, z) => {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(z, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
};
const derive = (seed, i) => {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const smooth = (x, wave) => {
  const g = Math.floor(x / wave);
  const r = x - g * wave;
  const n = r * r * (3 * wave - 2 * r);
  const d = wave * wave * wave;
  return [g, ratioSmall(n, d)];
};
const valueNoiseDS = (seed, x, z, wave) => {
  const [gx, tx] = smooth(x, wave);
  const [gz, tz] = smooth(z, wave);
  const v00 = fromU32Unit(hashBits(seed, gx, gz));
  const v10 = fromU32Unit(hashBits(seed, gx + 1, gz));
  const v01 = fromU32Unit(hashBits(seed, gx, gz + 1));
  const v11 = fromU32Unit(hashBits(seed, gx + 1, gz + 1));
  const top = add(v00, mul(sub(v10, v00), tx));
  const bottom = add(v01, mul(sub(v11, v01), tx));
  return add(top, mul(sub(bottom, top), tz));
};
const sumDS = (seed, x, z) => {
  let s = [0,0];
  s = add(s, valueNoiseDS(derive(seed,0),x,z,40));
  s = add(s, scalePow2(valueNoiseDS(derive(seed,1),x,z,20),0.5));
  s = add(s, scalePow2(valueNoiseDS(derive(seed,2),x,z,10),0.25));
  s = add(s, scalePow2(valueNoiseDS(derive(seed,3),x,z,5),0.125));
  return s;
};

// Classify directly in the unnormalized weighted-sum domain. The TS operation is monotonic;
// these split-f32 thresholds preserve ~45 bits while WGSL itself has no f64.
const LEVEL_THRESHOLDS = Array.from({length: 10}, (_, i) => {
  const k = i + 1;
  return fromNumber(1.875 * (0.55 + (k - 0.5) / 11));
});
const heightDS = (seed,x,z) => {
  const s = sumDS(seed,x,z);
  let h = 0;
  for (let i=0;i<LEVEL_THRESHOLDS.length;i++) if (ge(s,LEVEL_THRESHOLDS[i])) h=i+1; else break;
  return Math.min(h,10);
};

// f64 reference copied literally from terrainField.ts
const hashF64=(seed,x,z)=>hashBits(seed,x,z)/4294967296;
const smoothF64=t=>t*t*(3-2*t);
const valueF64=(seed,x,z,w)=>{const gx=Math.floor(x/w),gz=Math.floor(z/w),tx=smoothF64(x/w-gx),tz=smoothF64(z/w-gz);const a=hashF64(seed,gx,gz),b=hashF64(seed,gx+1,gz),c=hashF64(seed,gx,gz+1),d=hashF64(seed,gx+1,gz+1);const top=a+(b-a)*tx,bot=c+(d-c)*tx;return top+(bot-top)*tz};
const heightF64=(seed,x,z)=>{let n=valueF64(derive(seed,0),x,z,40)+valueF64(derive(seed,1),x,z,20)*.5+valueF64(derive(seed,2),x,z,10)*.25+valueF64(derive(seed,3),x,z,5)*.125;n/=1.875;if(n<.15)return 0;return Math.min(10,Math.round(Math.max(0,n-.55)*11));};

const seed=Number(process.argv[2]??305419896)>>>0,count=Number(process.argv[3]??1000000),half=Number(process.argv[4]??8192);
let state=0x6d2b79f5>>>0,m=0;const first=[];
for(let i=0;i<count;i++){
  state=(Math.imul(state,1664525)+1013904223)>>>0;const x=(state%(half*2+1))-half;
  state=(Math.imul(state,1664525)+1013904223)>>>0;const z=(state%(half*2+1))-half;
  const a=heightF64(seed,x,z),b=heightDS(seed,x,z);
  if(a!==b){m++;if(first.length<12)first.push({i,x,z,expected:a,actual:b});}
}
console.log(JSON.stringify({seed,count,mismatches:m,first}));

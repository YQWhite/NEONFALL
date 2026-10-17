// osu storyboard easing IDs (not UI easing IDs).
export function storyboardEase(id: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  if (t === 0 || t === 1) return t;
  const power = (n: number, mode: number) => mode === 0 ? t ** n : mode === 1 ? 1 - (1-t) ** n : t < .5 ? (2*t) ** n / 2 : 1 - (2-2*t) ** n / 2;
  const bounce = (x: number): number => { const n=7.5625,d=2.75; if(x<1/d)return n*x*x; if(x<2/d){x-=1.5/d;return n*x*x+.75;}if(x<2.5/d){x-=2.25/d;return n*x*x+.9375;}x-=2.625/d;return n*x*x+.984375; };
  const elasticOut = (x: number, period=.3) => 2 ** (-10*x) * Math.sin((x-period/4)*2*Math.PI/period)+1;
  if (id >= 3 && id <= 14) return power(2+Math.floor((id-3)/3),(id-3)%3);
  const c1=1.70158,c2=c1*1.525;
  switch(id){
    case 1:return power(2,1); case 2:return power(2,0);
    case 15:return 1-Math.cos(t*Math.PI/2);case 16:return Math.sin(t*Math.PI/2);case 17:return (1-Math.cos(Math.PI*t))/2;
    case 18:return 2 ** (10*t-10);case 19:return 1-2 ** (-10*t);case 20:return t<.5?2 ** (20*t-10)/2:(2-2 ** (-20*t+10))/2;
    case 21:return 1-Math.sqrt(1-t*t);case 22:return Math.sqrt(1-(t-1)**2);case 23:return t<.5?(1-Math.sqrt(1-(2*t)**2))/2:(Math.sqrt(1-(-2*t+2)**2)+1)/2;
    case 24:return 1-elasticOut(1-t);case 25:return elasticOut(t);case 26:return elasticOut(t,.6);case 27:return elasticOut(t,1.2);
    case 28:return t<.5?(1-elasticOut(1-2*t,.45))/2:(1+elasticOut(2*t-1,.45))/2;
    case 29:return (c1+1)*t*t*t-c1*t*t;case 30:return 1+(c1+1)*(t-1)**3+c1*(t-1)**2;
    case 31:return t<.5?(2*t)**2*((c2+1)*2*t-c2)/2:((2*t-2)**2*((c2+1)*(2*t-2)+c2)+2)/2;
    case 32:return 1-bounce(1-t);case 33:return bounce(t);case 34:return t<.5?(1-bounce(1-2*t))/2:(1+bounce(2*t-1))/2;
    default:return t;
  }
}

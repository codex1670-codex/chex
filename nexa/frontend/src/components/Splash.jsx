import { useEffect, useRef } from 'react';

// Small spinning-logo loader (uses the CHEX logo) for any in-app loading state.
export function LogoLoader({ size = 40, label }) {
  return (
    <span className="logo-loader" role="status" aria-label={label || 'Loading'}>
      <img src="/logo.png" width={size} height={size} alt="" draggable="false" />
    </span>
  );
}

// Full-screen launch screen: falling binary, rotating CHEX coin, wordmark, progress bar.
export default function Splash({ leaving = false }) {
  const canvas = useRef(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = c.getContext('2d');
    let w, h, cols, drops, raf, last = 0;
    const size = 16;
    const resize = () => {
      w = c.width = window.innerWidth; h = c.height = window.innerHeight;
      cols = Math.ceil(w / size);
      drops = Array.from({ length: cols }, () => Math.random() * -40);
    };
    resize();
    window.addEventListener('resize', resize);
    const tick = (t) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 60) return;
      last = t;
      ctx.fillStyle = 'rgba(5,10,20,0.14)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${size - 2}px monospace`;
      for (let i = 0; i < cols; i++) {
        const y = drops[i] * size;
        ctx.fillStyle = Math.random() > 0.96 ? '#e8f4ff' : 'rgba(90,150,230,0.55)';
        ctx.fillText(Math.random() > 0.5 ? '1' : '0', i * size, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i] += 1;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);

  return (
    <div className={`splash${leaving ? ' splash-out' : ''}`} role="status" aria-label="Loading CHEX">
      <canvas ref={canvas} className="splash-rain" />
      <div className="splash-center">
        <div className="coin-wrap">
          <span className="coin-ring r1" /><span className="coin-ring r2" />
          <div className="coin"><img src="/logo.png" alt="CHEX" draggable="false" /></div>
        </div>
        <div className="splash-name">chex</div>
        <div className="splash-tag">AI-powered social</div>
        <div className="splash-bar"><span /></div>
      </div>
    </div>
  );
}

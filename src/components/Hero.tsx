const POINTS = [
  { title: "Plan demand", body: "Understand buyer needs before the harvest moves.", icon: "chart" },
  { title: "Match supply", body: "Connect a load with buyers who can take it.", icon: "hands" },
  { title: "Redirect surplus", body: "See what still needs another market.", icon: "cycle" },
  { title: "Reduce waste", body: "Turn more of the harvest into a sale.", icon: "leaf" },
];

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-shade" aria-hidden="true" />
      <div className="shell hero-copy">
        <p className="hero-badge">Smart market solutions</p>
        <h1 id="hero-title">
          Know your market
          <span>before harvest.</span>
        </h1>
        <p className="hero-lede">
          Nyuma helps farmers and produce traders match expected supply with buyer demand and see what would remain
          unsold.
        </p>
        <div className="hero-actions">
          <a className="btn btn-lime" href="#login">
            Explore Nyuma
            <span aria-hidden="true">→</span>
          </a>
          <a className="btn btn-ghost" href="#how-it-works">
            <span className="play" aria-hidden="true" />
            Watch how it works
          </a>
        </div>
      </div>
      <div className="shell">
        <ul className="feature-bar">
          {POINTS.map((point) => (
            <li key={point.title}>
              <span className="point-icon" aria-hidden="true">
                <PointIcon name={point.icon} />
              </span>
              <span>
                <strong>{point.title}</strong>
                {point.body}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PointIcon({ name }: { name: string }) {
  if (name === "chart") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M4 16l4-5 3 3 8-9" />
      </svg>
    );
  }
  if (name === "hands") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M8 13l2 2 4-5" />
        <path d="M4 12h4M16 12h4" />
      </svg>
    );
  }
  if (name === "cycle") {
    return (
      <svg viewBox="0 0 24 24">
        <path d="M7 8a5 5 0 0 1 8-2l1 1" />
        <path d="M17 16a5 5 0 0 1-8 2l-1-1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 4c2 4 6 6 8 8-3 1-6 4-8 9-2-5-5-8-8-9 2-2 6-4 8-8z" />
    </svg>
  );
}

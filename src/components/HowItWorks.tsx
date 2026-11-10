const STEPS = [
  {
    id: "for-farmers",
    title: "Farmers",
    body: "Report the harvest that is ready to move.",
    image: "/hero-harvest.jpg",
  },
  {
    id: "for-buyers",
    title: "Traders",
    body: "Match that load with buyers who can collect.",
    image: "/market-traders.jpg",
  },
  {
    id: "for-processors",
    title: "Processors",
    body: "See the quantity that still needs a market.",
    image: "/market-crates.jpg",
  },
  {
    id: "value",
    title: "Value addition",
    body: "Decide what to do with what would remain.",
    image: "/melon-value.jpg",
  },
];

export function HowItWorks() {
  return (
    <section className="solution" id="how-it-works" aria-labelledby="how-title">
      <div className="shell solution-grid">
        <div>
          <p className="eyebrow">A complete solution</p>
          <h2 id="how-title">
            From farm to market
            <span>and beyond.</span>
          </h2>
          <p>
            Whether you farm, trade, or process produce, Nyuma is the check before a load is committed: who can take
            it, how much could be matched, and what would remain.
          </p>
          <a className="btn btn-lime" href="#login">
            Learn more
            <span aria-hidden="true">→</span>
          </a>
        </div>
        <ol className="journey">
          {STEPS.map((step) => (
            <li key={step.id} id={step.id}>
              <img src={step.image} alt="" />
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function About() {
  return (
    <section className="banner" id="about" aria-labelledby="about-title">
      <div className="banner-shade" aria-hidden="true" />
      <div className="shell banner-copy">
        <h2 id="about-title">Built for Kenya’s informal trade.</h2>
        <p>Smarter decisions. Clearer sales. Less produce left without a buyer.</p>
        <div className="hero-actions">
          <a className="btn btn-lime" href="#login">
            Get Started
            <span aria-hidden="true">→</span>
          </a>
          <a className="btn btn-ghost" href="#contact">
            Contact us
          </a>
        </div>
      </div>
    </section>
  );
}

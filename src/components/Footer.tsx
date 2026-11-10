import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="site-footer" id="contact">
      <div className="shell footer-grid">
        <div className="footer-brand">
          <Logo />
          <div>
            <p className="brand-name">Nyuma</p>
            <p>Together for a greener, more food-secure Kenya.</p>
          </div>
        </div>
        <nav aria-label="Footer">
          <a href="#about">About</a>
          <a href="#how-it-works">How it works</a>
          <a href="#for-farmers">For Farmers</a>
          <a href="#for-buyers">For Buyers</a>
          <a href="#for-processors">For Processors</a>
          <a href="#login">Workspace</a>
        </nav>
      </div>
    </footer>
  );
}

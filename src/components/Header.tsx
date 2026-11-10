import { useState } from "react";
import { Logo } from "./Logo";

const LINKS = [
  { href: "#top", label: "Home" },
  { href: "#about", label: "About" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#for-farmers", label: "For Farmers" },
  { href: "#for-buyers", label: "For Buyers" },
  { href: "#for-processors", label: "For Processors" },
  { href: "#contact", label: "Contact" },
];

export function Header() {
  const [open, setOpen] = useState(false);
  function close() {
    setOpen(false);
  }

  return (
    <header className="site-header" id="top">
      <div className="shell header-inner">
        <a className="brand" href="#top" onClick={close}>
          <Logo />
          <span className="brand-name">Nyuma</span>
        </a>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-controls="primary-nav"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close" : "Menu"}
        </button>
        <nav id="primary-nav" className={open ? "primary-nav is-open" : "primary-nav"} aria-label="Primary">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={close}>
              {link.label}
            </a>
          ))}
          <a className="header-login" href="#register" onClick={close}>
            Create account
          </a>
          <a className="header-login" href="#sign-in" onClick={close}>
            Sign in
          </a>
          <a className="header-login" href="#login" onClick={close}>
            Log in
          </a>
          <a className="header-cta" href="#login" onClick={close}>
            Get Started
            <span aria-hidden="true">→</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

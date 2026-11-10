export function Logo({ light = false }: { light?: boolean }) {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16.2 4.5c1.8 4.2 6 6.4 9.4 8.2-3.2 1.2-6.2 4.2-8.6 10.6-2.4-6.2-5.5-9.3-8.9-10.5 2.5-2 6.2-4.4 8.1-8.3z"
        fill={light ? "#b7f3c4" : "#1faa45"}
      />
    </svg>
  );
}

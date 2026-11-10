import { useId } from "react";

interface EmptyStateProps {
  title: string;
  body: string;
  later?: string;
}

export function EmptyState({ title, body, later }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="empty-state" aria-labelledby={titleId}>
      <h3 id={titleId}>{title}</h3>
      <p>{body}</p>
      {later ? <p className="coming-later">{later}</p> : null}
    </section>
  );
}

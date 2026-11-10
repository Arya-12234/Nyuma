import type { Recommendation } from "../types/decision";

interface RecommendationListProps {
  recommendations: readonly Recommendation[];
}

export function RecommendationList({ recommendations }: RecommendationListProps) {
  return (
    <section className="next-actions" id="updates" aria-labelledby="recommendation-title">
      <div className="block-heading">
        <h3 id="recommendation-title">Recent activity</h3>
        <p>Each note follows a fixed rule. None of them is a forecast.</p>
      </div>
      {recommendations.length === 0 ? (
        <p className="empty-note">No further action is suggested for this scenario.</p>
      ) : (
        <ol>
          {recommendations.map((recommendation) => (
            <li key={recommendation.id}>
              <p className="rec-message">{recommendation.message}</p>
              <p className="why">
                <span>Why this recommendation?</span>
                {recommendation.explanation}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

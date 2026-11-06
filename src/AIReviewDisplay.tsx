import './GitLabApprovals.css'

type CriticalSuggestion = { title: string; explanation: string; file: string; line: number | null }
export type AIReview = {
  status: 'reviewed' | 'unavailable' | 'skipped'
  provider?: 'openai' | 'groq'
  providerName?: string
  model?: string
  criticalSuggestions: CriticalSuggestion[]
  incomplete?: boolean
  reason?: string
}

export default function AIReviewDisplay({ review }: { review: AIReview }) {
  return (
              <div className={`ai-review ${review.criticalSuggestions.length ? 'has-critical' : ''}`}>
                <strong>AI review{review.providerName ? ` · ${review.providerName}` : ''}</strong>
                {review.status === 'skipped' && <p>{review.reason || 'AI review skipped.'}</p>}
                {review.status === 'unavailable' && <p>{review.reason || 'AI review unavailable.'}</p>}
                {review.status === 'reviewed' && !review.criticalSuggestions.length && <p>No critical suggestions found.{review.incomplete ? ' Review coverage is incomplete.' : ''}</p>}
                {!!review.criticalSuggestions.length && <ul>{review.criticalSuggestions.map((suggestion, index) => (
                  <li key={`${suggestion.file}:${suggestion.line}:${index}`}><strong>{suggestion.title}</strong><span>{suggestion.file}{suggestion.line ? `:${suggestion.line}` : ''}</span><p>{suggestion.explanation}</p></li>
                ))}</ul>}
                {review.criticalSuggestions.length > 0 && review.reason && <p>{review.reason}</p>}
              </div>
  )
}

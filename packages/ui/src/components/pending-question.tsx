import { useState, useEffect, useRef, useMemo } from 'react';
import axios from 'axios';

interface PendingQ {
  id: string;
  jobTitle: string;
  company: string;
  question: string;
  type: string;
  options?: string[];
  defaultValue?: string;
}

// Notification sound — short beep using Web Audio API
function playNotificationSound() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.3;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.stop(ctx.currentTime + 0.5);
  } catch {
    // ignore if audio not available
  }
}

export function PendingQuestion() {
  const [questions, setQuestions] = useState<PendingQ[]>([]);
  const [answer, setAnswer] = useState('');
  const [saveAsRule, setSaveAsRule] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [optionSearch, setOptionSearch] = useState('');
  const prevCountRef = useRef(0);

  // Poll for pending questions every 2 seconds
  useEffect(() => {
    const poll = async () => {
      try {
        const { data } = await axios.get<PendingQ[]>('/api/form-answers/pending');
        setQuestions(data);

        // Pre-fill answer with defaultValue if available
        if (data.length > 0 && prevCountRef.current === 0 && data[0].defaultValue) {
          setAnswer(data[0].defaultValue);
        }

        // Play sound when new question arrives
        if (data.length > 0 && prevCountRef.current === 0) {
          playNotificationSound();
          // Also update page title to draw attention
          document.title = '⚠ Bot needs your input — CareerLens';
        }
        if (data.length === 0 && prevCountRef.current > 0) {
          document.title = 'CareerLens';
        }
        prevCountRef.current = data.length;
      } catch {
        // ignore
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);

  const current = questions[0];

  const handleSubmit = async () => {
    if (!current || !answer.trim()) return;
    setSubmitting(true);
    try {
      await axios.post(`/api/form-answers/pending/${current.id}/answer`, {
        answer: answer.trim(),
        saveAsRule,
      });
      setAnswer('');
      setQuestions((prev) => prev.filter((q) => q.id !== current.id));
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (!current) return;
    setSubmitting(true);
    try {
      await axios.post(`/api/form-answers/pending/${current.id}/answer`, {
        answer: '__SKIP__',
        saveAsRule: false,
      });
      setAnswer('');
      setQuestions((prev) => prev.filter((q) => q.id !== current.id));
    } catch {
      // ignore
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      handleSkip();
    }
  };

  if (!current) return null;

  return (
    <div className="pq-overlay">
      <div className="pq-modal">
        <div className="pq-header">
          <div className="pq-badge">Bot needs your input</div>
          <button className="modal-close" onClick={handleSkip} title="Skip (Esc)">&times;</button>
        </div>
        <div className="pq-job">
          {current.jobTitle} <span className="pq-company">@ {current.company}</span>
        </div>

        <div className="pq-question">{current.question}</div>

        {current.options && current.options.length > 10 ? (
          <div className="pq-searchable-options">
            <input
              className="pq-input"
              placeholder="Type to search..."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            {answer && (
              <div className="pq-option-list">
                {current.options
                  .filter((opt) => opt.toLowerCase().includes(answer.toLowerCase()))
                  .slice(0, 15)
                  .map((opt) => (
                    <button
                      key={opt}
                      className={`pq-option ${answer === opt ? 'selected' : ''}`}
                      onClick={() => setAnswer(opt)}
                    >
                      {opt}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ) : current.options && current.options.length > 0 ? (
          <div className="pq-options">
            {current.options.map((opt) => (
              <button
                key={opt}
                className={`pq-option ${answer === opt ? 'selected' : ''}`}
                onClick={() => setAnswer(opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <div className="pq-input-row">
            {current.type === 'textarea' ? (
              <textarea
                className="pq-textarea"
                placeholder="Type your answer..."
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={current.defaultValue ? 10 : 3}
              />
            ) : (
              <input
                className="pq-input"
                placeholder="Type your answer..."
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
            )}
          </div>
        )}

        <div className="pq-footer">
          <label className="pq-save-rule">
            <input
              type="checkbox"
              checked={saveAsRule}
              onChange={(e) => setSaveAsRule(e.target.checked)}
            />
            Save for future
          </label>
          <button
            className="pq-submit"
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
          >
            {submitting ? 'Sending...' : 'Submit'}
          </button>
        </div>

        {questions.length > 1 && (
          <div className="pq-queue">{questions.length - 1} more question{questions.length > 2 ? 's' : ''} waiting</div>
        )}
      </div>
    </div>
  );
}

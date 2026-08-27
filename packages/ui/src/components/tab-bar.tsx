export type Tab = 'queue' | 'applied' | 'interviewing' | 'accepted' | 'rejected' | 'cover-letters' | 'prepare' | 'applications';

interface TabBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  counts: { queue: number; applied: number; interviewing: number; accepted: number; rejected: number; coverLetters: number; prepare: number; applications: number };
  /** Applications stopped after a submit was attempted — they may be duplicates. */
  applicationsNeedReview?: number;
  onOpenCommands: () => void;
  onOpenKeywords: () => void;
}

export function TabBar({ activeTab, onTabChange, counts, applicationsNeedReview = 0, onOpenCommands, onOpenKeywords }: TabBarProps) {
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'queue', label: 'Queue', count: counts.queue },
    { key: 'prepare', label: 'Prepare', count: counts.prepare },
    { key: 'applied', label: 'Applied', count: counts.applied },
    { key: 'interviewing', label: 'Interviewing', count: counts.interviewing },
    { key: 'accepted', label: 'Accepted', count: counts.accepted },
    { key: 'rejected', label: 'Rejected', count: counts.rejected },
    { key: 'cover-letters', label: 'Cover Letters', count: counts.coverLetters },
    // Counts what still needs a decision, not the full history — the reason to
    // open this tab is that something is waiting on you.
    { key: 'applications', label: 'Applications', count: counts.applications },
  ];

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`tab-btn ${activeTab === tab.key ? 'active' : ''}${
            tab.key === 'applications' && applicationsNeedReview > 0 ? ' needs-review' : ''
          }`}
          title={
            tab.key === 'applications' && applicationsNeedReview > 0
              ? `${applicationsNeedReview} application(s) may already have been submitted — check before retrying`
              : undefined
          }
          onClick={() => onTabChange(tab.key)}
        >
          {tab.label}
          <span className="count">({tab.count})</span>
        </button>
      ))}
      <div className="tab-spacer" />
      <button className="pipeline-btn keywords-btn" onClick={onOpenKeywords}>
        Keywords
      </button>
      <button className="pipeline-btn" onClick={onOpenCommands}>
        Commands
      </button>
    </div>
  );
}

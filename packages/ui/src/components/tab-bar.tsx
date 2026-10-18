export type Tab =
  | 'queue'
  | 'applied'
  | 'interviewing'
  | 'accepted'
  | 'rejected'
  | 'cover-letters'
  | 'prepare'
  | 'applications';

export type TabCounts = {
  queue: number;
  applied: number;
  interviewing: number;
  accepted: number;
  rejected: number;
  coverLetters: number;
  prepare: number;
  applications: number;
};

export interface TabInfo {
  key: Tab;
  label: string;
  count: number;
  description: string;
  icon: string;
}

/** The one list of tabs — shared by the tab bar and the home cards so they can't drift. */
export function tabList(counts: TabCounts): TabInfo[] {
  return [
    {
      key: 'queue',
      label: 'Queue',
      count: counts.queue,
      icon: '📥',
      description: 'Scored jobs waiting for you to apply',
    },
    {
      key: 'prepare',
      label: 'Prepare',
      count: counts.prepare,
      icon: '📝',
      description: 'Application fields to review before auto-apply',
    },
    {
      key: 'applied',
      label: 'Applied',
      count: counts.applied,
      icon: '📤',
      description: 'Applications you have sent',
    },
    {
      key: 'interviewing',
      label: 'Interviewing',
      count: counts.interviewing,
      icon: '💬',
      description: 'Roles with interviews in progress',
    },
    {
      key: 'accepted',
      label: 'Application Accepted',
      count: counts.accepted,
      icon: '🎉',
      description: 'Applications that moved you forward',
    },
    {
      key: 'rejected',
      label: 'Application Filtered',
      count: counts.rejected,
      icon: '🗂️',
      description: 'Jobs filtered out or turned down',
    },
    {
      key: 'cover-letters',
      label: 'Cover Letters',
      count: counts.coverLetters,
      icon: '✉️',
      description: 'Generated cover letters by job',
    },
    // Counts what still needs a decision, not the full history — the reason to
    // open this tab is that something is waiting on you.
    {
      key: 'applications',
      label: 'Applications',
      count: counts.applications,
      icon: '⚙️',
      description: 'Auto-apply runs and their history',
    },
  ];
}

const needsReviewTitle = (n: number) =>
  `${n} application(s) may already have been submitted — check before retrying`;

interface TabBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  counts: TabCounts;
  /** Applications stopped after a submit was attempted — they may be duplicates. */
  applicationsNeedReview?: number;
}

export function TabBar({
  activeTab,
  onTabChange,
  counts,
  applicationsNeedReview = 0,
}: TabBarProps) {
  return (
    <div className="tab-bar">
      {tabList(counts).map((tab) => {
        const flagged = tab.key === 'applications' && applicationsNeedReview > 0;
        return (
          <button
            key={tab.key}
            className={`tab-btn ${activeTab === tab.key ? 'active' : ''}${flagged ? ' needs-review' : ''}`}
            title={flagged ? needsReviewTitle(applicationsNeedReview) : undefined}
            onClick={() => onTabChange(tab.key)}
          >
            {tab.label}
            <span className="count">({tab.count})</span>
          </button>
        );
      })}
    </div>
  );
}

interface HomeCardsProps {
  counts: TabCounts;
  applicationsNeedReview?: number;
  onOpen: (tab: Tab) => void;
}

export function HomeCards({ counts, applicationsNeedReview = 0, onOpen }: HomeCardsProps) {
  return (
    <div className="home-grid">
      {tabList(counts).map((tab) => {
        const flagged = tab.key === 'applications' && applicationsNeedReview > 0;
        return (
          <button
            key={tab.key}
            className={`home-card home-card-${tab.key}${flagged ? ' needs-review' : ''}`}
            title={flagged ? needsReviewTitle(applicationsNeedReview) : undefined}
            onClick={() => onOpen(tab.key)}
          >
            <div className="home-card-top">
              <span className="home-card-icon" aria-hidden>
                {tab.icon}
              </span>
              <span className="home-card-count">{tab.count}</span>
            </div>
            <div className="home-card-label">{tab.label}</div>
            <div className="home-card-desc">{tab.description}</div>
            {flagged && <div className="home-card-flag">{applicationsNeedReview} need review</div>}
            <span className="home-card-open">Open →</span>
          </button>
        );
      })}
    </div>
  );
}

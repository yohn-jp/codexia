import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';

export const resultContent = style({
  maxHeight: '24rem',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
});

export const jobProgress = style({ display: 'flex', alignItems: 'center', gap: '0.5rem' });
export const unreadCountBadge = style({ marginInlineStart: '0.35rem' });

export const dialog = style({
  width: 'min(54rem, calc(100vw - 2rem))',
  maxHeight: 'min(84vh, 52rem)',
  margin: 'auto',
  padding: '1rem',
  overflow: 'auto',
  border: '1px solid var(--line)',
  borderRadius: '0.6rem',
  color: 'var(--ink)',
  background: 'var(--paper)',
});

export const header = style({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' });
export const title = style({ margin: '0' });
export const notificationHeader = style({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '1rem' });
export const notificationItem = recipe({
  variants: {
    read: {
      true: { opacity: '0.72' },
      false: {},
    },
  },
  defaultVariants: { read: false },
});
export const notificationRow = style({ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' });
export const notificationContent = style({ minWidth: '0', overflowWrap: 'anywhere' });
export const notificationBody = style({ marginBlock: '0.35rem', whiteSpace: 'pre-wrap' });
export const footer = style({ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBlockStart: '1rem' });

import { recipe } from '@vanilla-extract/recipes';

export const sessionContent = recipe({
  variants: {
    state: {
      active: { display: 'contents' },
      blocked: { display: 'none' },
    },
  },
  defaultVariants: { state: 'active' },
});

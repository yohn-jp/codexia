import { recipe } from '@vanilla-extract/recipes';

export const buttonSize = recipe({
  variants: {
    size: {
      compact: {
        minHeight: '2.4rem',
        padding: '0.35rem 0.55rem',
      },
    },
  },
});

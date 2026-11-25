import { recipe } from '@vanilla-extract/recipes';

export const buttonRecipe = recipe({
  variants: {
    size: {
      compact: {
        minHeight: '2.4rem',
        paddingBlock: '0.35rem',
        paddingInline: '0.55rem',
      },
    },
  },
});

import { type ButtonHTMLAttributes } from 'react';

import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

/**
 * `medium` is what every button in the app was before this prop existed, and
 * it stays the default so adding the option changed nothing anywhere. `small`
 * is for dense panels where a full-size control crowds the thing it acts on.
 */
type ButtonSize = 'small' | 'medium';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = 'secondary',
  size = 'medium',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = [styles.button, styles[variant], styles[size], className]
    .filter(Boolean)
    .join(' ');
  return <button type={type} className={classes} {...props} />;
}

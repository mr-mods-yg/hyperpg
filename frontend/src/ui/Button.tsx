import { forwardRef, type ButtonHTMLAttributes } from 'react'
import './Button.css'

type ButtonStyleProps = {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  iconOnly?: boolean
  className?: string
}

// Reuse the same appearance for native disclosure controls such as <summary>.
export function buttonClassName({ variant = 'secondary', size = 'md', iconOnly = false, className = '' }: ButtonStyleProps = {}) {
  return ['ui-button', `ui-button--${variant}`, `ui-button--${size}`, iconOnly && 'ui-button--icon', className].filter(Boolean).join(' ')
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ButtonStyleProps

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, iconOnly, className, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={buttonClassName({ variant, size, iconOnly, className })} {...props} />
})

export default Button

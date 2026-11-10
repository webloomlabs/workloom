import { cn } from '@workloom/ui'

/**
 * The woven W monogram, cropped tight to its shapes (roughly 2:1).
 *
 * It paints in `currentColor` so it follows the theme: the default
 * `text-accent-text` is lime on the dark canvas and a deeper olive on the light
 * one, where pale lime would wash out. Size it by height; the width follows.
 * The tab icon in `app/icon.svg` keeps the fixed lime from the source file.
 */
export function WorkloomMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="24 30 980 480"
      fill="currentColor"
      aria-hidden
      className={cn('h-4 w-auto shrink-0 text-accent-text', className)}
    >
      <path d="M73 30H173C202 30 225 42 239 68L403 380C414 400 425 413 439 422L403 478C390 498 371 510 344 510H291C262 510 238 495 224 470L30 98C13 66 35 30 73 30Z" />
      <path d="M343 243L419 126C437 98 460 82 491 82H550C587 82 615 99 634 130L687 213C661 208 642 206 625 206C597 206 578 218 562 241L446 412C432 399 424 385 413 366Z" />
      <path d="M518 335L580 244C593 226 611 218 633 223L773 411C786 429 800 438 821 445L802 479C789 499 769 510 743 510H662C634 510 614 498 600 475Z" />
      <path d="M703 285L803 69C815 43 839 30 869 30H955C993 30 1015 63 997 98L830 433C810 428 797 420 785 404Z" />
    </svg>
  )
}

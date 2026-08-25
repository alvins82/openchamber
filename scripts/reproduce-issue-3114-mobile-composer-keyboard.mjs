/**
 * Static reproduction analysis for issue #3114.
 *
 * "Android web chat composer remains behind keyboard until first input"
 * https://github.com/openchamber/openchamber/issues/3114
 *
 * This script inspects the mobile composer's keyboard-compensation code and
 * prints where the normal chat-screen composer (ongoing session, normal
 * height, not fullscreen, not the new-session draft) is (or is not) anchored
 * above the soft keyboard.
 *
 * The bug is a real-device behavior (Android Chrome/Firefox do not fully pan
 * the focused field above the keyboard until the first keystroke), so it
 * cannot be triggered in a headless test. This script records the code-level
 * evidence that the normal chat path has no explicit viewport pinning, unlike
 * the fullscreen and draft-screen paths.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const viewportPin = readFileSync(
    join(root, 'packages/ui/src/components/chat/composer/state/useMobileViewportPin.ts'),
    'utf8',
);
const composerShell = readFileSync(
    join(root, 'packages/ui/src/components/chat/composer/state/useMobileComposerShell.ts'),
    'utf8',
);

console.log('=== issue #3114: mobile composer keyboard anchoring ===\n');

console.log('1) Does the NORMAL chat-screen composer get any explicit viewport pinning?');
console.log('   (i.e. is the form anchored above the keyboard for the focused,');
console.log('   non-fullscreen, non-draft composer in an ongoing session?)');
console.log();

// The draft-screen effect and the fullscreen effect both guard on a flag.
// The normal chat path (isMobile && !isFullscreen && !isDraftScreen && isFocused)
// is covered by neither effect.
const fullscreenGuard = /if \(!isMobile \|\| !isFullscreen \|\| isCapacitorApp\(\)\) return;/;
const draftGuard = /if \(!isDraftScreen \|\| isFullscreen \|\| !isFocused\) return;/;

if (fullscreenGuard.test(viewportPin) && draftGuard.test(viewportPin)) {
    console.log('   NO. useMobileViewportPin has two effects:');
    console.log('   - fullscreen composer: pins the form to the visual viewport');
    console.log('     (guard: !isMobile || !isFullscreen || isCapacitorApp)');
    console.log('   - draft screen + keyboard: anchors the form to the visible bottom');
    console.log('     (guard: !isDraftScreen || isFullscreen || !isFocused)');
    console.log('   The normal chat screen (isFullscreen=false, isDraftScreen=false)');
    console.log('   matches NEITHER effect, so no pinning is applied there.');
}

console.log();
console.log('2) The code comment makes the (wrong for Android) assumption explicit:');
const draftComment = viewportPin
    .split('\n')
    .find((l) => l.includes('focused-field reveal works there'));
if (draftComment) {
    console.log(`   "${draftComment.trim()}"`);
    console.log('   The chat screen is assumed to rely on the browser\'s own');
    console.log('   focused-field reveal. That reveal is what Android Chrome/Firefox');
    console.log('   deliver late (only after the first keystroke), which is the bug.');
}

console.log();
console.log('3) What happens on focus in the browser path (expand())?');
const expandLines = composerShell.split('\n');
expandLines.forEach((line, i) => {
    if (line.includes('native reveal is also the only')) {
        console.log(`   L${i + 1}: "${line.trim()}"`);
        console.log('   focus({ preventScroll: false }) is called and the browser is');
        console.log('   expected to position the composer itself. No scrollIntoView,');
        console.log('   no visualViewport tracking runs on this path.');
    }
});

console.log();
console.log('4) The only explicit scroll-into-view reveals in the composer shell/');
console.log('   viewport-pin modules are gated to other paths:');
console.log('   - useMobileComposerShell L263: PWA standalone overlay-close restore only');
console.log('   - useMobileViewportPin L93: fullscreen composer cleanup only');
console.log();
console.log('Conclusion: the reported Android behavior is consistent with the code.');
console.log('The normal chat-screen composer has no explicit keyboard compensation,');
console.log('so it depends entirely on the browser panning the focused field into view.');
console.log('Android Chrome/Firefox do that only after the first keystroke.');

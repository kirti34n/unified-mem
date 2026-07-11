# vhs tape: reproducible demo GIF (https://github.com/charmbracelet/vhs)
# Render:  vhs docs/demo.tape    (produces docs/demo.gif, keep <= 3 MB)
#
# The flow: install the curated starter notes (real, generic gotchas, trust:seed,
# so they ARE injected into real sessions, unlike the fictional trust:demo seed),
# then show the UserPromptSubmit hook surfacing the matching pitfall on a prompt
# that shares no keywords with the note. retrieve-prompt.mjs prints exactly what
# the hook injects, so the demo is verifiable offline with no LLM call.
Output docs/demo.gif
Set FontSize 15
Set Width 1100
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "node scripts/starter.mjs"
Enter
Sleep 2s
Type `echo '{"session_id":"demo","cwd":"/tmp/billing-worker","prompt":"my build script crashes with a UnicodeEncodeError printing emoji on windows"}' | node scripts/retrieve-prompt.mjs`
Enter
Sleep 4s
Type "# matched on the situation via triggers, not shared words. Dashboard: node scripts/dashboard.mjs"
Sleep 3s

# vhs tape: reproducible demo GIF (https://github.com/charmbracelet/vhs)
# Render:  vhs docs/demo.tape    (produces docs/demo.gif, keep <= 3 MB)
#
# The README hero is docs/demo.svg, which is the literal stdout of the two commands below,
# captured by running them. The GIF that used to sit there was a hand-composed mockup: it typed a
# `claude "..."` command this tape never contained, printed "10 real pitfall notes" where
# starter.mjs prints "generic", and dropped the header and provenance lines the code emits. It was
# deleted rather than kept, because a drawing of a terminal at the top of a README about not
# overselling is the one asset that cannot be allowed to stay. If you render this tape, diff the
# result against docs/demo.svg before you ship it: the tape and the code must agree.
#
# The flow: install the curated starter notes (real, generic gotchas, trust:seed,
# so they ARE injected into real sessions, unlike the fictional trust:demo seed),
# then show the UserPromptSubmit hook surfacing the matching pitfall on a prompt
# that states only the symptom, never the cause (cp1252) or the fix. The match is
# plain rare-word overlap: the hook only injects a note that contains at least 2 of
# the prompt's rare terms, and this note contains 5 of them (script, crashes,
# printing, emoji, unicodeencodeerror). retrieve-prompt.mjs prints exactly what
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
Type "# matched on shared rare words (script, crashes, printing, emoji, UnicodeEncodeError); the prompt never named the fix. Dashboard: node scripts/dashboard.mjs"
Sleep 3s

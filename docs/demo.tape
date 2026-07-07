# vhs tape: reproducible demo GIF (https://github.com/charmbracelet/vhs)
# Render:  vhs docs/demo.tape    (produces docs/demo.gif, keep <= 3 MB)
Output docs/demo.gif
Set FontSize 15
Set Width 1100
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "cd unified-mem && node scripts/init.mjs"
Enter
Sleep 2s
Type "node scripts/seed.mjs"
Enter
Sleep 1.5s
Type `echo '{"session_id":"demo","cwd":"/tmp","prompt":"why intermittent 401 bursts during jwt token refresh?"}' | node scripts/retrieve-prompt.mjs`
Enter
Sleep 4s
Type "# the vault answered from a past session. Dashboard: node scripts/dashboard.mjs"
Sleep 3s

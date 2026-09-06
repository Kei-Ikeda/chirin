### This is where notification permission is granted

macOS shows its notification permission prompt exactly once, **the first time an app posts a
notification**. chirin posts through `osascript`, a separate process, so macOS attributes the
notification to the script runner rather than to chirin or to VS Code — it appears as Script
Editor or similar (the exact name varies by OS version).

If you miss the prompt, or want to grant permission later:

open **System Settings → Notifications**, find the entry that appeared after the test
notification, and turn on "Allow Notifications". That entry does not exist in the list until a
notification has actually been posted, so send the test notification first.

The test notification lets you pick a rule. Choosing a real rule fires it with that rule's
template and sound, so you can confirm exactly how it will look and sound in practice.

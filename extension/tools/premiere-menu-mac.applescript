-- Render Hare — fire Premiere's own Clip > Render and Replace / Restore
-- Unrendered on macOS (BETA).
--
-- Usage: osascript premiere-menu-mac.applescript <waitSeconds> <label> [<label> ...]
--   labels = the menu item's name in every language Premiere ships (the panel
--   passes them from ../locales/menu-strings.json); the first match is clicked.
--
-- Uses System Events GUI scripting, so macOS asks once to allow Adobe Premiere
-- Pro under System Settings > Privacy & Security > Accessibility.
--
-- With waitSeconds > 0, waits for the dialogs the command opens (new windows of
-- the Premiere process) to appear and all close again.
--
-- Prints one JSON line: {"ok":true,"dialogSeen":..,"finished":..} | {"ok":false,"error":".."}

on run argv
	if (count of argv) < 2 then return my fail("usage: <waitSeconds> <label>...")
	set waitSeconds to (item 1 of argv) as integer
	set targetLabels to items 2 thru -1 of argv

	try
		tell application "System Events"
			set procs to (every process whose name starts with "Adobe Premiere Pro")
			if procs is {} then return my fail("Premiere Pro isn't running.")
			set p to item 1 of procs

			set foundItem to missing value
			repeat with mbi in (menu bar items of menu bar 1 of p)
				try
					set itemNames to name of menu items of menu 1 of mbi
					repeat with j from 1 to count of itemNames
						set n to item j of itemNames
						if n is not missing value and targetLabels contains n then
							set foundItem to menu item j of menu 1 of mbi
							exit repeat
						end if
					end repeat
				end try
				if foundItem is not missing value then exit repeat
			end repeat
			if foundItem is missing value then return my fail("The menu item wasn't found (unsupported Premiere language or version).")

			set baseline to count of windows of p
			-- A menu item that opens a modal dialog doesn't answer until the
			-- dialog closes; don't wait for it.
			ignoring application responses
				click foundItem
			end ignoring
		end tell
	on error errMsg number errNum
		if errNum is -1719 or errNum is -25211 or errNum is -10006 or errMsg contains "assistive" then
			return my fail("accessibility")
		end if
		return my fail(errMsg)
	end try

	set seen to false
	set finished to "null"
	if waitSeconds > 0 then
		-- Phase 1: a dialog should appear within a few seconds (none = no dialog).
		repeat 16 times
			if my windowCount(p) > baseline then
				set seen to true
				exit repeat
			end if
			delay 0.25
		end repeat
		-- Phase 2: done once no extra window has been open for 2 s straight.
		if seen then
			set finished to "false"
			set clearFor to 0
			set elapsed to 0
			repeat while elapsed < waitSeconds
				if my windowCount(p) > baseline then
					set clearFor to 0
				else
					set clearFor to clearFor + 0.5
					if clearFor >= 2 then
						set finished to "true"
						exit repeat
					end if
				end if
				delay 0.5
				set elapsed to elapsed + 0.5
			end repeat
		else
			set finished to "true"
		end if
	end if
	return "{\"ok\":true,\"dialogSeen\":" & (seen as text) & ",\"finished\":" & finished & "}"
end run

on windowCount(p)
	try
		tell application "System Events" to return count of windows of p
	on error
		return 0
	end try
end windowCount

on fail(msg)
	set AppleScript's text item delimiters to "\\"
	set parts to text items of msg
	set AppleScript's text item delimiters to "\\\\"
	set msg to parts as text
	set AppleScript's text item delimiters to "\""
	set parts to text items of msg
	set AppleScript's text item delimiters to "\\\""
	set msg to parts as text
	set AppleScript's text item delimiters to ""
	return "{\"ok\":false,\"error\":\"" & msg & "\"}"
end fail

# Builds onecal/index.html (the hosted site) from site/onecal.html (the page, also used as the Claude artifact).
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
page = (root / 'site/onecal.html').read_text().replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Onecal reads your team's Gmail and Google Calendars and puts every confirmed meeting on one shared calendar, deduped, tagged by who's in it, with the join link attached.">
<meta property="og:title" content="Onecal: every inbox, one calendar">
<meta property="og:description" content="One shared Google Calendar for your whole team, built from everyone's inboxes and calendars.">
<meta property="og:type" content="website">
<meta name="theme-color" content="#F3F6F5">
<link rel="icon" href="https://onecal-app.vercel.app/favicon.svg" type="image/svg+xml">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
'''
split = page.index('<header class="nav">')
(root / 'onecal/index.html').write_text(head + page[:split] + '</head>\n<body>\n' + page[split:] + '\n</body>\n</html>\n')
print('built onecal/index.html')

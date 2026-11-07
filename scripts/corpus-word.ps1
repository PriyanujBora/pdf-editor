# Writes tests/corpus/word-2019.pdf: real "Word > Save as PDF" output for the edit-stability
# harness (Windows + Microsoft Word only; the corpus is gitignored). Run: npm run corpus:word
# ASCII-only script; Indic lines are read from indic.txt (UTF-8).
param([string]$OutPdf = (Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\corpus\word-2019.pdf'))
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$indic = Get-Content -Encoding UTF8 (Join-Path $here 'corpus-word-indic.txt')

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $doc.PageSetup.PaperSize = 7 # wdPaperA4
  $sel = $word.Selection
  function Reset-Font {
    $sel.Font.Reset()
    $sel.Font.Name = 'Calibri'; $sel.Font.Size = 11; $sel.Font.Bold = 0; $sel.Font.Italic = 0
    $sel.Font.Color = -16777216; $sel.Font.Underline = 0; $sel.Font.Spacing = 0; $sel.Font.Superscript = 0
  }
  Reset-Font

  # Mixed bold label + regular text + coloured hyperlink on one line (G4)
  $sel.Font.Bold = 1; $sel.TypeText('Name:'); $sel.Font.Bold = 0
  $sel.TypeText(' John Smith, email ')
  $null = $doc.Hyperlinks.Add($sel.Range, 'mailto:john.smith@example.com', [Type]::Missing, [Type]::Missing, 'john.smith@example.com')
  $sel.EndKey(6) | Out-Null
  $sel.TypeParagraph(); Reset-Font

  # Coloured bold word in a regular line (G4)
  $sel.TypeText('Status: '); $sel.Font.Bold = 1; $sel.Font.Color = 255; $sel.TypeText('OVERDUE')
  $sel.Font.Bold = 0; $sel.Font.Color = 0; $sel.TypeText(' since 3 March 2026, reminder sent')
  $sel.TypeParagraph(); Reset-Font

  # Bulleted list: Word draws the bullet with the Symbol font (G5)
  $sel.Range.ListFormat.ApplyBulletDefault()
  $sel.TypeText('Managed a team of five engineers across two sites'); $sel.TypeParagraph()
  $sel.TypeText('Reduced invoice processing time by 40 percent'); $sel.TypeParagraph()
  $sel.Range.ListFormat.RemoveNumbers()
  Reset-Font

  # Superscript (G5)
  $sel.TypeText('Revenue grew 3x in 2025'); $sel.Font.Superscript = 1; $sel.TypeText('1')
  $sel.Font.Superscript = 0; $sel.TypeText(' across all regions')
  $sel.TypeParagraph(); Reset-Font

  # Letter-spaced heading (G7)
  $sel.Font.Bold = 1; $sel.Font.Size = 14; $sel.Font.Spacing = 3; $sel.TypeText('QUARTERLY SUMMARY')
  $sel.TypeParagraph(); Reset-Font

  # Justified paragraph (G7)
  $sel.ParagraphFormat.Alignment = 3
  $sel.TypeText('The committee reviewed the annual budget proposal in detail and approved the revised allocation for infrastructure, training and community outreach programmes, subject to the conditions listed in the attached schedule and the usual quarterly reporting requirements set by the board.')
  $sel.TypeParagraph()
  $sel.ParagraphFormat.Alignment = 0
  Reset-Font

  # One line per common font (G6)
  foreach ($f in 'Calibri', 'Arial', 'Cambria', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Segoe UI') {
    $sel.Font.Name = $f; $sel.TypeText("${f}: The committee approved the annual budget"); $sel.TypeParagraph()
  }
  Reset-Font
  $sel.Font.Name = 'Nirmala UI'
  foreach ($l in $indic) { if ($l) { $sel.TypeText($l); $sel.TypeParagraph() } }

  $doc.ExportAsFixedFormat($OutPdf, 17)
  $doc.Close(0)
} finally {
  # Close anything left open without saving, or Quit() silently refuses (alerts are off).
  foreach ($d in @($word.Documents)) { $d.Close(0) }
  $word.Quit(0)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
"written $OutPdf"

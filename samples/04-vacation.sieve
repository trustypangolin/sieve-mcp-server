# Out-of-office auto-reply. Each sender gets at most one reply every :days days.
# Replies are never sent to mailing lists, bulk mail, or auto-generated mail.
# The "date" test limits the reply to a date range, so you can leave it in place.

require ["vacation", "date", "relational"];

if allof (currentdate :value "ge" "date" "2026-12-20",
          currentdate :value "le" "date" "2027-01-05") {
    vacation
        :days 7
        :subject "Away until 5 January"
        :addresses ["me@example.com", "me@alias.example.com"]
        "Thanks for your message. I am away until 5 January with limited access to email and will reply when I am back.";
}

# No stop here: delivery continues and the message is still kept as normal.

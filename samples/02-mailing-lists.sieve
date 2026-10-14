# Sort mailing lists by their List-Id header, one folder per list,
# without having to write a rule for each list.

require ["fileinto", "mailbox", "variables"];

# List-Id: Example Users <users.lists.example.org>  ->  folder "Lists/users"
if header :matches "list-id" "*<*.*>*" {
    set :lower "list" "${2}";
    fileinto :create "Lists/${list}";
    stop;
}

# Newsletters usually carry List-Unsubscribe even without List-Id
if exists "list-unsubscribe" {
    fileinto :create "Newsletters";
    stop;
}

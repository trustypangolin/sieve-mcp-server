# Plus addressing: mail to me+shopping@example.com goes to the folder "Plus/shopping".
# Give each site its own +tag to see who leaks or sells your address.

require ["fileinto", "mailbox", "envelope", "subaddress", "variables"];

if envelope :detail :matches "to" "?*" {
    set :lower "tag" "${0}";
    fileinto :create "Plus/${tag}";
    stop;
}

// Sellable tracking snippet - embed on merchant site
// Usage: <script src="https://your-domain.com/public/sellable-track.js" data-track-key="YOUR_KEY"></script>
(function () {
  var script = document.currentScript;
  var trackKey = script.getAttribute("data-track-key");
  var baseUrl = script.src.replace(/\/public\/sellable-track\.js.*$/, "");

  function getCart() {
    try {
      if (window.sellableCart) return window.sellableCart;
      return null;
    } catch (e) {
      return null;
    }
  }

  function sendCart(cart) {
    if (!cart) return;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", baseUrl + "/api/track/cart", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-Track-Key", trackKey);
    xhr.send(
      JSON.stringify({
        cart_id: cart.id,
        items: cart.items,
        total_paise: cart.total_paise,
        customer: cart.customer,
      })
    );
  }

  var debounceTimer;
  function debounceSend() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      sendCart(getCart());
    }, 1000);
  }

  // Expose global hook
  window.SellableTrack = {
    updateCart: function (cart) {
      window.sellableCart = cart;
      debounceSend();
    },
    orderConfirmed: function (cartId) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", baseUrl + "/api/track/order-confirmed", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("X-Track-Key", trackKey);
      xhr.send(JSON.stringify({ cart_id: cartId }));
    },
  };
})();

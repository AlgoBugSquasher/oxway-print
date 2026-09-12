// Razorpay Checkout is distributed as a script tag, not an npm package.
// This loads it once and caches the promise for subsequent calls.
// Window.Razorpay itself is typed in types/razorpay.d.ts.

let scriptPromise: Promise<void> | null = null;

export function loadRazorpayCheckout(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("Razorpay Checkout requires a browser."));
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Could not load Razorpay Checkout."));
    };
    document.body.appendChild(script);
  });

  return scriptPromise;
}

// Contact form: posts to the demo API and shows a confirmation.
const form = document.getElementById("contact-form");
const status = document.getElementById("form-status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (!data.name || !data.email || !data.message) {
    status.className = "notice";
    status.textContent = "Please fill in every field.";
    return;
  }
  try {
    const res = await fetch("/demo/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(String(res.status));
    status.className = "notice ok";
    status.textContent = "Thanks — we'll be in touch within a day.";
    form.reset();
  } catch {
    status.className = "notice";
    status.textContent = "Something went wrong. Please try again.";
  }
});

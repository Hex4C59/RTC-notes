document.querySelectorAll('[data-quiz]').forEach((quiz) => {
  const feedback = quiz.querySelector('[data-feedback]');
  quiz.querySelectorAll('button[data-correct]').forEach((button) => {
    button.addEventListener('click', () => {
      const correct = button.dataset.correct === 'true';
      quiz.querySelectorAll('button[data-correct]').forEach((choice) => {
        choice.setAttribute('aria-pressed', String(choice === button));
      });
      feedback.textContent = correct ? quiz.dataset.right : quiz.dataset.wrong;
      feedback.dataset.result = correct ? 'right' : 'wrong';
    });
  });
});

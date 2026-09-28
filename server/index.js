const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());

app.use('/api/sources', require('./routes/sources'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/items', require('./routes/items'));
app.use('/api/picks', require('./routes/picks'));
app.use('/api', require('./routes/taxonomy'));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

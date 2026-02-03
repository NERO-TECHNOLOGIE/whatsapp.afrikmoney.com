import Joi from 'joi';

const sessionIdSchema = Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(3).max(50).required();

export const validateSessionId = (req, res, next) => {
    const { id } = req.params;
    const { error } = sessionIdSchema.validate(id);

    if (error) {
        return res.status(400).json({ error: error.details[0].message });
    }

    next();
};

export const validateInitInstance = (req, res, next) => {
    const { id } = req.params;
    const { error } = Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(3).max(50).required().validate(id);

    if (error) {
        return res.status(400).json({ error: 'Invalid Instance ID format' });
    }

    next();
};
